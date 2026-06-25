#include "foobar2000/SDK/foobar2000.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>

#include <atomic>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
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

std::string lowercase_copy(const std::string& value) {
    std::string out = value;
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return out;
}

bool contains_case_insensitive(const std::string& haystack, const std::string& needle) {
    if (needle.empty()) return false;
    return lowercase_copy(haystack).find(lowercase_copy(needle)) != std::string::npos;
}

bool select_playlist_by_name(const std::string& name, bool contains) {
    if (name.empty()) return false;
    static_api_ptr_t<playlist_manager> playlists;
    const t_size count = playlists->get_playlist_count();
    for (t_size i = 0; i < count; i++) {
        pfc::string8 playlist_name;
        playlists->playlist_get_name(i, playlist_name);
        const std::string current = playlist_name.c_str();
        const bool matched = contains ? contains_case_insensitive(current, name) : _stricmp(current.c_str(), name.c_str()) == 0;
        if (matched) {
            playlists->set_active_playlist(i);
            playlists->set_playing_playlist(i);
            return true;
        }
    }
    return false;
}

bool move_active_playlist(int delta) {
    static_api_ptr_t<playlist_manager> playlists;
    const t_size count = playlists->get_playlist_count();
    if (count == 0) return false;
    t_size active = playlists->get_active_playlist();
    if (active == pfc_infinite || active >= count) active = 0;
    const int next = (static_cast<int>(active) + delta + static_cast<int>(count)) % static_cast<int>(count);
    playlists->set_active_playlist(static_cast<t_size>(next));
    playlists->set_playing_playlist(static_cast<t_size>(next));
    return true;
}

std::string track_display_name(metadb_handle_ptr handle) {
    if (!handle.is_valid()) return {};
    file_info_impl info;
    if (handle->get_info(info)) {
        const char* artist = info.meta_get("artist", 0);
        const char* title = info.meta_get("title", 0);
        if (artist && title) return std::string(artist) + " - " + title;
        if (title) return title;
    }
    return handle->get_path();
}

std::string active_playlist_name() {
    static_api_ptr_t<playlist_manager> playlists;
    const t_size active = playlists->get_active_playlist();
    if (active == pfc_infinite || active >= playlists->get_playlist_count()) return {};
    pfc::string8 name;
    playlists->playlist_get_name(active, name);
    return name.c_str();
}

bool cycle_playback_order() {
    static_api_ptr_t<playback_order_manager> order_manager;
    const t_size count = playback_order::g_get_count();
    if (count == 0) return false;
    t_size active = order_manager->get_active_order();
    if (active == pfc_infinite || active >= count) active = 0;
    order_manager->set_active_order((active + 1) % count);
    return true;
}

std::string current_playback_order_name() {
    static_api_ptr_t<playback_order_manager> order_manager;
    pfc::string8 name;
    const t_size active = order_manager->get_active_order();
    if (active != pfc_infinite && active < playback_order::g_get_count()) {
        playback_order::g_get_name(active, name);
    }
    return name.c_str();
}

std::string directory_from_path(const std::string& path) {
    const auto pos = path.find_last_of("\\/");
    if (pos == std::string::npos) return {};
    return path.substr(0, pos + 1);
}

int hex_value(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

std::string url_decode_path(const std::string& value) {
    std::string out;
    for (size_t i = 0; i < value.size(); i++) {
        if (value[i] == '%' && i + 2 < value.size()) {
            const int high = hex_value(value[i + 1]);
            const int low = hex_value(value[i + 2]);
            if (high >= 0 && low >= 0) {
                out.push_back(static_cast<char>((high << 4) | low));
                i += 2;
                continue;
            }
        }
        out.push_back(value[i] == '/' ? '\\' : value[i]);
    }
    return out;
}

std::string local_path_from_track_path(const std::string& track_path) {
    const std::string prefix = "file://";
    if (track_path.rfind(prefix, 0) == 0) {
        return url_decode_path(track_path.substr(prefix.size()));
    }
    return track_path;
}

std::string mime_from_path(const std::string& path) {
    const auto pos = path.find_last_of('.');
    const std::string ext = pos == std::string::npos ? "" : path.substr(pos + 1);
    if (_stricmp(ext.c_str(), "png") == 0) return "image/png";
    if (_stricmp(ext.c_str(), "webp") == 0) return "image/webp";
    return "image/jpeg";
}

std::string read_cover_data_url(const std::string& track_path) {
    const std::string directory = directory_from_path(local_path_from_track_path(track_path));
    if (directory.empty()) return {};
    const char* names[] = {
        "cover.jpg", "folder.jpg", "front.jpg", "album.jpg",
        "cover.png", "folder.png", "front.png", "album.png",
        "cover.webp", "folder.webp"
    };
    for (const char* name : names) {
        const std::string path = directory + name;
        DWORD attrs = GetFileAttributesA(path.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
            continue;
        }
        std::ifstream file(path, std::ios::binary | std::ios::ate);
        if (!file) continue;
        const std::streamsize size = file.tellg();
        if (size <= 0 || size > 2 * 1024 * 1024) continue;
        file.seekg(0, std::ios::beg);
        std::vector<unsigned char> bytes(static_cast<size_t>(size));
        if (!file.read(reinterpret_cast<char*>(bytes.data()), size)) continue;
        return "data:" + mime_from_path(path) + ";base64," + base64_encode(bytes.data(), static_cast<DWORD>(bytes.size()));
    }
    return {};
}

class streamdock_server;
streamdock_server* g_server = nullptr;
void broadcast_current_state();
std::mutex g_rating_mutex;
std::map<std::string, int> g_runtime_ratings;
std::mutex g_browser_mutex;
t_size g_playlist_browser_index = 0;

int rating_for_track(const std::string& track_path) {
    std::lock_guard<std::mutex> lock(g_rating_mutex);
    const auto it = g_runtime_ratings.find(track_path);
    return it == g_runtime_ratings.end() ? 0 : it->second;
}

void set_rating_for_now_playing(int rating) {
    static_api_ptr_t<playback_control> playback;
    metadb_handle_ptr handle;
    if (!playback->get_now_playing(handle) || !handle.is_valid()) return;
    const int normalized = std::max(1, std::min(5, rating));
    std::lock_guard<std::mutex> lock(g_rating_mutex);
    g_runtime_ratings[handle->get_path()] = normalized;
}

void adjust_playlist_browser(int delta) {
    static_api_ptr_t<playlist_manager> playlists;
    const t_size active = playlists->get_active_playlist();
    if (active == pfc_infinite || active >= playlists->get_playlist_count()) return;
    const t_size count = playlists->playlist_get_item_count(active);
    if (count == 0) return;
    std::lock_guard<std::mutex> lock(g_browser_mutex);
    const int next = (static_cast<int>(g_playlist_browser_index) + delta + static_cast<int>(count)) % static_cast<int>(count);
    g_playlist_browser_index = static_cast<t_size>(next);
}

void play_selected_playlist_item() {
    static_api_ptr_t<playlist_manager> playlists;
    const t_size active = playlists->get_active_playlist();
    if (active == pfc_infinite || active >= playlists->get_playlist_count()) return;
    const t_size count = playlists->playlist_get_item_count(active);
    if (count == 0) return;
    t_size index = 0;
    {
        std::lock_guard<std::mutex> lock(g_browser_mutex);
        if (g_playlist_browser_index >= count) g_playlist_browser_index = 0;
        index = g_playlist_browser_index;
    }
    playlists->set_playing_playlist(active);
    playlists->playlist_execute_default_action(active, index);
}

std::string browser_track_name(t_size& index, t_size& count) {
    static_api_ptr_t<playlist_manager> playlists;
    const t_size active = playlists->get_active_playlist();
    count = 0;
    index = 0;
    if (active == pfc_infinite || active >= playlists->get_playlist_count()) return {};
    count = playlists->playlist_get_item_count(active);
    if (count == 0) return {};
    {
        std::lock_guard<std::mutex> lock(g_browser_mutex);
        if (g_playlist_browser_index >= count) g_playlist_browser_index = 0;
        index = g_playlist_browser_index;
    }
    metadb_handle_ptr item;
    if (!playlists->playlist_get_item_handle(item, active, index)) return {};
    return track_display_name(item);
}

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
    std::string image;
    int rating = 0;
    t_size browse_index = 0;
    t_size browse_count = 0;
    const std::string playlist = active_playlist_name();
    const std::string browse_track = browser_track_name(browse_index, browse_count);
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
        image = read_cover_data_url(track.c_str());
        rating = rating_for_track(track.c_str());
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
    json += ",\"playbackOrder\":\"";
    json += json_escape(current_playback_order_name().c_str());
    json += "\",\"playlist\":\"";
    json += json_escape(playlist.c_str());
    json += "\",\"browseTrack\":\"";
    json += json_escape(browse_track.c_str());
    json += "\",\"browseIndex\":";
    json += std::to_string(static_cast<unsigned long long>(browse_index));
    json += ",\"browseCount\":";
    json += std::to_string(static_cast<unsigned long long>(browse_count));
    json += ",\"rating\":";
    json += std::to_string(rating);
    json += ",\"artist\":\"";
    json += json_escape(artist.c_str());
    json += "\",\"title\":\"";
    json += json_escape(title.c_str());
    json += "\",\"track\":\"";
    json += json_escape(track.c_str());
    json += "\"";
    if (!image.empty()) {
        json += ",\"image\":\"";
        json += image;
        json += "\"";
    }
    json += "}}";
    return json;
}

class command_callback : public main_thread_callback {
public:
    explicit command_callback(std::string command, int amount, int seconds, int value, int delta, std::string name, std::string query)
        : m_command(std::move(command)), m_amount(amount), m_seconds(seconds), m_value(value), m_delta(delta), m_name(std::move(name)), m_query(std::move(query)) {}

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
        } else if (m_command == "set_volume_percent") {
            const float percent = std::max(0.0f, std::min(100.0f, static_cast<float>(m_value)));
            const float db = percent <= 0.0f ? -100.0f : 20.0f * std::log10(percent / 100.0f);
            playback->set_volume(db);
        } else if (m_command == "mute") {
            playback->volume_mute_toggle();
        } else if (m_command == "seek_delta") {
            playback->playback_seek_delta(static_cast<double>(m_seconds));
        } else if (m_command == "cycle_playback_order") {
            cycle_playback_order();
        } else if (m_command == "playlist_select") {
            select_playlist_by_name(m_name, false);
        } else if (m_command == "playlist_next") {
            move_active_playlist(1);
        } else if (m_command == "playlist_previous") {
            move_active_playlist(-1);
        } else if (m_command == "playlist_search" || m_command == "library_search") {
            select_playlist_by_name(m_query.empty() ? m_name : m_query, true);
        } else if (m_command == "playlist_browse_delta") {
            adjust_playlist_browser(m_delta);
        } else if (m_command == "playlist_play_selected") {
            play_selected_playlist_item();
        } else if (m_command == "rating_set") {
            set_rating_for_now_playing(m_value);
        }
        broadcast_current_state();
    }

private:
    std::string m_command;
    int m_amount = 1;
    int m_seconds = 0;
    int m_value = 0;
    int m_delta = 0;
    std::string m_name;
    std::string m_query;
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
                const int delta = extract_int_field(text, "delta", 0);
                const std::string name = extract_string_field(text, "name");
                const std::string query = extract_string_field(text, "query");
                static_api_ptr_t<main_thread_callback_manager> callbacks;
                callbacks->add_callback(new service_impl_t<command_callback>(command, amount, seconds, value, delta, name, query));
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
            command == "set_volume_percent" ||
            command == "mute" ||
            command == "seek_delta" ||
            command == "cycle_playback_order" ||
            command == "playlist_select" ||
            command == "playlist_next" ||
            command == "playlist_previous" ||
            command == "rating_set" ||
            command == "playlist_search" ||
            command == "playlist_browse_delta" ||
            command == "playlist_play_selected" ||
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
