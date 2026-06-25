#include "foobar2000/SDK/foobar2000.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>

#include <atomic>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")

DECLARE_COMPONENT_VERSION(
    "foo_streamdock_control",
    "0.1.0",
    "Localhost WebSocket control surface for Mirabox Stream Dock.");
VALIDATE_COMPONENT_FILENAME("foo_streamdock_control.dll");

namespace {

constexpr unsigned short kPort = 41920;
constexpr char kWebSocketGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

std::string json_escape(const char* value) {
    std::string out;
    if (!value) return out;
    for (const unsigned char ch : std::string(value)) {
        switch (ch) {
        case '\\': out += "\\\\"; break;
        case '"': out += "\\\""; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (ch < 0x20) {
                char buf[7] = {};
                sprintf_s(buf, "\\u%04x", ch);
                out += buf;
            } else {
                out.push_back(static_cast<char>(ch));
            }
        }
    }
    return out;
}

std::string base64_encode(const unsigned char* data, DWORD size) {
    DWORD output_size = 0;
    CryptBinaryToStringA(data, size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &output_size);
    std::string output(output_size, '\0');
    CryptBinaryToStringA(data, size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, output.data(), &output_size);
    if (!output.empty() && output.back() == '\0') output.pop_back();
    return output;
}

std::string sha1_base64(const std::string& input) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD object_size = 0;
    DWORD data_size = 0;
    std::vector<unsigned char> object;
    unsigned char digest[20] = {};

    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA1_ALGORITHM, nullptr, 0) != 0) return {};
    BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &data_size, 0);
    object.resize(object_size);
    if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) != 0) {
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return {};
    }
    BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(input.data())), static_cast<ULONG>(input.size()), 0);
    BCryptFinishHash(hash, digest, sizeof(digest), 0);
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return base64_encode(digest, sizeof(digest));
}

std::string header_value(const std::string& request, const std::string& name) {
    const std::string needle = name + ":";
    const auto start = request.find(needle);
    if (start == std::string::npos) return {};
    auto value_start = start + needle.size();
    while (value_start < request.size() && (request[value_start] == ' ' || request[value_start] == '\t')) value_start++;
    const auto value_end = request.find("\r\n", value_start);
    return request.substr(value_start, value_end == std::string::npos ? std::string::npos : value_end - value_start);
}

bool send_all(SOCKET socket, const unsigned char* data, size_t size) {
    size_t sent = 0;
    while (sent < size) {
        const int rc = send(socket, reinterpret_cast<const char*>(data + sent), static_cast<int>(size - sent), 0);
        if (rc <= 0) return false;
        sent += static_cast<size_t>(rc);
    }
    return true;
}

bool send_text_frame(SOCKET socket, const std::string& text) {
    std::vector<unsigned char> frame;
    frame.push_back(0x81);
    if (text.size() < 126) {
        frame.push_back(static_cast<unsigned char>(text.size()));
    } else if (text.size() <= 0xffff) {
        frame.push_back(126);
        frame.push_back(static_cast<unsigned char>((text.size() >> 8) & 0xff));
        frame.push_back(static_cast<unsigned char>(text.size() & 0xff));
    } else {
        return false;
    }
    frame.insert(frame.end(), text.begin(), text.end());
    return send_all(socket, frame.data(), frame.size());
}

bool recv_exact(SOCKET socket, unsigned char* data, size_t size) {
    size_t received = 0;
    while (received < size) {
        const int rc = recv(socket, reinterpret_cast<char*>(data + received), static_cast<int>(size - received), 0);
        if (rc <= 0) return false;
        received += static_cast<size_t>(rc);
    }
    return true;
}

bool read_text_frame(SOCKET socket, std::string& text) {
    unsigned char header[2] = {};
    if (!recv_exact(socket, header, 2)) return false;
    const unsigned char opcode = header[0] & 0x0f;
    if (opcode == 0x8) return false;
    if (opcode != 0x1) return false;

    const bool masked = (header[1] & 0x80) != 0;
    unsigned long long length = header[1] & 0x7f;
    if (length == 126) {
        unsigned char ext[2] = {};
        if (!recv_exact(socket, ext, 2)) return false;
        length = (static_cast<unsigned long long>(ext[0]) << 8) | ext[1];
    } else if (length == 127) {
        return false;
    }
    if (length > 65535) return false;

    unsigned char mask[4] = {};
    if (masked && !recv_exact(socket, mask, 4)) return false;
    std::vector<unsigned char> payload(static_cast<size_t>(length));
    if (!payload.empty() && !recv_exact(socket, payload.data(), payload.size())) return false;
    if (masked) {
        for (size_t i = 0; i < payload.size(); i++) payload[i] ^= mask[i % 4];
    }
    text.assign(payload.begin(), payload.end());
    return true;
}

std::string extract_command(const std::string& json) {
    const auto key = json.find("\"command\"");
    if (key == std::string::npos) return {};
    const auto colon = json.find(':', key);
    if (colon == std::string::npos) return {};
    const auto first_quote = json.find('"', colon + 1);
    if (first_quote == std::string::npos) return {};
    const auto second_quote = json.find('"', first_quote + 1);
    if (second_quote == std::string::npos) return {};
    return json.substr(first_quote + 1, second_quote - first_quote - 1);
}

int extract_amount(const std::string& json) {
    const auto key = json.find("\"amount\"");
    if (key == std::string::npos) return 1;
    const auto colon = json.find(':', key);
    if (colon == std::string::npos) return 1;
    const auto start = json.find_first_of("-0123456789", colon + 1);
    if (start == std::string::npos) return 1;
    const auto end = json.find_first_not_of("0123456789", start + 1);
    const int amount = atoi(json.substr(start, end == std::string::npos ? std::string::npos : end - start).c_str());
    return std::max(1, std::min(20, amount));
}

int extract_int_field(const std::string& json, const char* name, int fallback) {
    const std::string key = std::string("\"") + name + "\"";
    const auto key_pos = json.find(key);
    if (key_pos == std::string::npos) return fallback;
    const auto colon = json.find(':', key_pos);
    if (colon == std::string::npos) return fallback;
    const auto start = json.find_first_of("-0123456789", colon + 1);
    if (start == std::string::npos) return fallback;
    const auto end = json.find_first_not_of("0123456789", start + 1);
    return atoi(json.substr(start, end == std::string::npos ? std::string::npos : end - start).c_str());
}

std::string extract_string_field(const std::string& json, const char* name) {
    const std::string key = std::string("\"") + name + "\"";
    const auto key_pos = json.find(key);
    if (key_pos == std::string::npos) return {};
    const auto colon = json.find(':', key_pos);
    if (colon == std::string::npos) return {};
    const auto first_quote = json.find('"', colon + 1);
    if (first_quote == std::string::npos) return {};
    const auto second_quote = json.find('"', first_quote + 1);
    if (second_quote == std::string::npos) return {};
    return json.substr(first_quote + 1, second_quote - first_quote - 1);
}

class streamdock_server;
streamdock_server* g_server = nullptr;
void broadcast_current_state();

std::string make_state_json() {
    static_api_ptr_t<playback_control> playback;
    const bool playing = playback->is_playing();
    const bool paused = playback->is_paused();
    const float volume_db = playback->get_volume();
    const float volume_percent = std::max(0.0f, std::min(100.0f, std::pow(10.0f, volume_db / 20.0f) * 100.0f));
    const double position = playback->playback_get_position();
    double length = 0;
    pfc::string8 artist;
    pfc::string8 title;
    pfc::string8 track;
    metadb_handle_ptr handle;

    if (playback->get_now_playing(handle) && handle.is_valid()) {
        length = handle->get_length();
        file_info_impl info;
        if (handle->get_info(info)) {
            const char* artist_value = info.meta_get("artist", 0);
            const char* title_value = info.meta_get("title", 0);
            if (artist_value) artist = artist_value;
            if (title_value) title = title_value;
        }
        track = handle->get_path();
    }

    char volume_text[64] = {};
    sprintf_s(volume_text, "%.2f", volume_db);
    char volume_percent_text[64] = {};
    sprintf_s(volume_percent_text, "%.0f", volume_percent);

    std::string json = "{\"event\":\"state\",\"payload\":{";
    json += "\"playing\":";
    json += playing && !paused ? "true" : "false";
    json += ",\"paused\":";
    json += paused ? "true" : "false";
    json += ",\"volumeDb\":";
    json += volume_text;
    json += ",\"volume\":";
    json += volume_percent_text;
    char position_text[64] = {};
    sprintf_s(position_text, "%.0f", std::max(0.0, position));
    char length_text[64] = {};
    sprintf_s(length_text, "%.0f", std::max(0.0, length));
    json += ",\"positionSeconds\":";
    json += position_text;
    json += ",\"lengthSeconds\":";
    json += length_text;
    json += ",\"muted\":false";
    json += ",\"artist\":\"";
    json += json_escape(artist.c_str());
    json += "\",\"title\":\"";
    json += json_escape(title.c_str());
    json += "\",\"track\":\"";
    json += json_escape(track.c_str());
    json += "\"}}";
    return json;
}

class command_callback : public main_thread_callback {
public:
    explicit command_callback(std::string command, int amount, int seconds, int value, std::string name)
        : m_command(std::move(command)), m_amount(amount), m_seconds(seconds), m_value(value), m_name(std::move(name)) {}

    void callback_run() override {
        static_api_ptr_t<playback_control> playback;
        if (m_command == "play_pause") {
            playback->play_or_pause();
        } else if (m_command == "stop") {
            playback->stop();
        } else if (m_command == "next") {
            playback->next();
        } else if (m_command == "previous") {
            playback->previous();
        } else if (m_command == "volume_up") {
            for (int i = 0; i < m_amount; i++) playback->volume_up();
        } else if (m_command == "volume_down") {
            for (int i = 0; i < m_amount; i++) playback->volume_down();
        } else if (m_command == "mute") {
            playback->volume_mute_toggle();
        } else if (m_command == "seek_delta") {
            playback->playback_seek_delta(static_cast<double>(m_seconds));
        } else if (m_command == "cycle_playback_order") {
            // Playback-order APIs differ between foobar2000 SDK generations.
            // Keep this as a command boundary; wire to playback_order_manager in the target SDK project if needed.
        } else if (m_command == "playlist_search" || m_command == "library_search") {
            // Search APIs differ by SDK/project setup. The Stream Dock side can send this command;
            // wire it to playlist_manager/library_manager in the target SDK project if needed.
        }
        broadcast_current_state();
    }

private:
    std::string m_command;
    int m_amount = 1;
    int m_seconds = 0;
    int m_value = 0;
    std::string m_name;
};

class streamdock_server {
public:
    void start() {
        if (m_running.exchange(true)) return;
        g_server = this;
        m_thread = std::thread([this] { run(); });
    }

    void stop() {
        if (!m_running.exchange(false)) return;
        closesocket(m_listen_socket);
        {
            std::lock_guard<std::mutex> lock(m_clients_mutex);
            for (SOCKET client : m_clients) closesocket(client);
            m_clients.clear();
        }
        if (m_thread.joinable()) m_thread.join();
        WSACleanup();
        g_server = nullptr;
    }

    void broadcast_state() {
        broadcast(make_state_json());
    }

    void broadcast(const std::string& message) {
        std::lock_guard<std::mutex> lock(m_clients_mutex);
        for (auto it = m_clients.begin(); it != m_clients.end();) {
            if (!send_text_frame(*it, message)) {
                closesocket(*it);
                it = m_clients.erase(it);
            } else {
                ++it;
            }
        }
    }

private:
    void run() {
        WSADATA wsa = {};
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return;

        m_listen_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (m_listen_socket == INVALID_SOCKET) return;

        sockaddr_in address = {};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = htons(kPort);
        if (bind(m_listen_socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR) return;
        if (listen(m_listen_socket, SOMAXCONN) == SOCKET_ERROR) return;

        while (m_running) {
            SOCKET client = accept(m_listen_socket, nullptr, nullptr);
            if (client == INVALID_SOCKET) {
                if (m_running) Sleep(100);
                continue;
            }
            std::thread([this, client] { handle_client(client); }).detach();
        }
    }

    void handle_client(SOCKET client) {
        if (!handshake(client)) {
            closesocket(client);
            return;
        }

        {
            std::lock_guard<std::mutex> lock(m_clients_mutex);
            m_clients.push_back(client);
        }
        send_text_frame(client, make_state_json());

        std::string text;
        while (m_running && read_text_frame(client, text)) {
            const std::string command = extract_command(text);
            if (command == "now_playing") {
                send_text_frame(client, make_state_json());
            } else if (is_allowed_command(command)) {
                const int amount = extract_amount(text);
                const int seconds = extract_int_field(text, "seconds", 0);
                const int value = extract_int_field(text, "value", 0);
                const std::string name = extract_string_field(text, "name");
                static_api_ptr_t<main_thread_callback_manager> callbacks;
                callbacks->add_callback(new service_impl_t<command_callback>(command, amount, seconds, value, name));
            } else {
                send_text_frame(client, "{\"event\":\"error\",\"message\":\"unknown command\"}");
            }
        }

        {
            std::lock_guard<std::mutex> lock(m_clients_mutex);
            m_clients.erase(std::remove(m_clients.begin(), m_clients.end(), client), m_clients.end());
        }
        closesocket(client);
    }

    bool handshake(SOCKET client) {
        char buffer[4096] = {};
        const int rc = recv(client, buffer, sizeof(buffer) - 1, 0);
        if (rc <= 0) return false;
        const std::string request(buffer, static_cast<size_t>(rc));
        const std::string key = header_value(request, "Sec-WebSocket-Key");
        if (key.empty()) return false;
        const std::string accept = sha1_base64(key + kWebSocketGuid);
        const std::string response =
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        return send_all(client, reinterpret_cast<const unsigned char*>(response.data()), response.size());
    }

    static bool is_allowed_command(const std::string& command) {
        return command == "play_pause" ||
            command == "stop" ||
            command == "next" ||
            command == "previous" ||
            command == "volume_up" ||
            command == "volume_down" ||
            command == "mute" ||
            command == "seek_delta" ||
            command == "cycle_playback_order" ||
            command == "playlist_select" ||
            command == "playlist_next" ||
            command == "playlist_previous" ||
            command == "rating_set" ||
            command == "playlist_search" ||
            command == "library_search";
    }

    std::atomic<bool> m_running{ false };
    SOCKET m_listen_socket = INVALID_SOCKET;
    std::thread m_thread;
    std::mutex m_clients_mutex;
    std::vector<SOCKET> m_clients;
};

streamdock_server g_streamdock_server;

void broadcast_current_state() {
    if (g_server) {
        g_server->broadcast_state();
    }
}

class streamdock_initquit : public initquit {
public:
    void on_init() override {
        g_streamdock_server.start();
    }
    void on_quit() override {
        g_streamdock_server.stop();
    }
};

class streamdock_play_callback : public play_callback_static {
public:
    unsigned get_flags() override {
        return flag_on_playback_new_track |
            flag_on_playback_stop |
            flag_on_playback_pause |
            flag_on_volume_change |
            flag_on_playback_time;
    }

    void on_playback_starting(play_control::t_track_command, bool) override {}
    void on_playback_new_track(metadb_handle_ptr) override { g_streamdock_server.broadcast_state(); }
    void on_playback_stop(play_control::t_stop_reason) override { g_streamdock_server.broadcast_state(); }
    void on_playback_seek(double) override {}
    void on_playback_pause(bool) override { g_streamdock_server.broadcast_state(); }
    void on_playback_edited(metadb_handle_ptr) override { g_streamdock_server.broadcast_state(); }
    void on_playback_dynamic_info(const file_info&) override {}
    void on_playback_dynamic_info_track(const file_info&) override { g_streamdock_server.broadcast_state(); }
    void on_playback_time(double) override { g_streamdock_server.broadcast_state(); }
    void on_volume_change(float) override { g_streamdock_server.broadcast_state(); }
};

initquit_factory_t<streamdock_initquit> g_streamdock_initquit_factory;
static play_callback_static_factory_t<streamdock_play_callback> g_streamdock_play_callback_factory;

} // namespace
