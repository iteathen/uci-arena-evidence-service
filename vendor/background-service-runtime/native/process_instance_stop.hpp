#pragma once

#include "process_instance_query.hpp"
#include <charconv>
#include <string_view>

namespace uci_arena::background_service_runtime {

enum class ProcessInstanceStopState { stopped, absent, reused, unverifiable, deferred };

inline ProcessInstanceStopState stop_process_handle(HANDLE process, DWORD process_id,
    std::uint64_t creation_ticks, const std::string& executable, ULONGLONG deadline) {
    const auto observation = inspect_process_handle(process, process_id);
    if (observation.state == ProcessInstanceState::absent) return ProcessInstanceStopState::absent;
    if (observation.state != ProcessInstanceState::present) return ProcessInstanceStopState::unverifiable;
    if (observation.creation_utc_ticks != creation_ticks || observation.executable_path != executable) {
        return ProcessInstanceStopState::reused;
    }
    if (GetTickCount64() >= deadline) return ProcessInstanceStopState::deferred;
    // The handle inspected above is the only termination and exit-wait authority.
    if (TerminateProcess(process, 70) == FALSE) {
        return WaitForSingleObject(process, 0) == WAIT_OBJECT_0
            ? ProcessInstanceStopState::absent : ProcessInstanceStopState::unverifiable;
    }
    const auto now = GetTickCount64();
    const auto remaining = now < deadline ? static_cast<DWORD>(deadline - now) : 0;
    const auto wait = WaitForSingleObject(process, remaining);
    if (wait == WAIT_OBJECT_0) return ProcessInstanceStopState::stopped;
    return wait == WAIT_TIMEOUT ? ProcessInstanceStopState::deferred : ProcessInstanceStopState::unverifiable;
}

inline ProcessInstanceStopState stop_process_instance(DWORD process_id, std::uint64_t creation_ticks,
    const std::string& executable, ULONGLONG deadline) {
    if (process_id == 0) return ProcessInstanceStopState::unverifiable;
    ProcessHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | PROCESS_TERMINATE,
        FALSE, process_id));
    if (process.get() == nullptr) return GetLastError() == ERROR_INVALID_PARAMETER
        ? ProcessInstanceStopState::absent : ProcessInstanceStopState::unverifiable;
    const auto result = stop_process_handle(process.get(), process_id, creation_ticks, executable, deadline);
    return process.close() ? result : ProcessInstanceStopState::unverifiable;
}

struct ProcessStopRequest {
    DWORD pid = 0;
    std::uint64_t creation_ticks = 0;
    DWORD timeout_ms = 0;
    std::string executable;
};

template<class Integer> inline bool stop_decimal(std::string_view input, Integer& value) {
    if (input.empty()) return false;
    const auto parsed = std::from_chars(input.data(), input.data() + input.size(), value);
    return parsed.ec == std::errc{} && parsed.ptr == input.data() + input.size();
}

inline bool parse_process_stop_request(const std::string& input, ProcessStopRequest& request) {
    if (input.size() > 131128) return false;
    std::array<std::string_view, 4> fields{};
    std::size_t offset = 0;
    for (auto& field : fields) {
        const auto end = input.find('\n', offset);
        if (end == std::string::npos) return false;
        field = std::string_view(input).substr(offset, end - offset);
        offset = end + 1;
    }
    if (offset != input.size() || !stop_decimal(fields[0], request.pid) || request.pid == 0
        || fields[1].size() > 19 || !stop_decimal(fields[1], request.creation_ticks)
        || request.creation_ticks < 504911232000000000ULL || request.creation_ticks > 3155378975999999999ULL
        || !stop_decimal(fields[2], request.timeout_ms) || request.timeout_ms == 0 || request.timeout_ms > 2000
        || fields[3].empty() || fields[3].size() > 4 * 32767
        || fields[3].find_first_of(std::string_view("\0\r", 2)) != std::string_view::npos) return false;
    const auto executable = fields[3];
    const bool drive = executable.size() >= 3
        && ((executable[0] >= 'A' && executable[0] <= 'Z') || (executable[0] >= 'a' && executable[0] <= 'z'))
        && executable[1] == ':' && (executable[2] == '\\' || executable[2] == '/');
    const bool unc = executable.size() >= 3 && executable[0] == '\\' && executable[1] == '\\';
    if (!drive && !unc) return false;
    const auto units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, executable.data(),
        static_cast<int>(executable.size()), nullptr, 0);
    if (units <= 0 || units > 32767) return false;
    request.executable.assign(executable);
    return true;
}

inline const char* process_stop_state_name(ProcessInstanceStopState state) {
    switch (state) {
        case ProcessInstanceStopState::stopped: return "stopped";
        case ProcessInstanceStopState::absent: return "absent";
        case ProcessInstanceStopState::reused: return "reused";
        case ProcessInstanceStopState::deferred: return "deferred";
        default: return "unverifiable";
    }
}

} // namespace uci_arena::background_service_runtime
