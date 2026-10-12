#include "process_instance_stop.hpp"
#include <iostream>
#include <stdexcept>
#include <vector>

namespace runtime = uci_arena::background_service_runtime;
using State = runtime::ProcessInstanceStopState;
void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

struct OwnedChild {
    PROCESS_INFORMATION process{};
    OwnedChild() {
        std::array<wchar_t, 32768> executable{};
        require(GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size())) != 0,
            "fixture executable unavailable");
        std::wstring command = L"\"" + std::wstring(executable.data()) + L"\" --owned-child";
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        require(CreateProcessW(executable.data(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
            nullptr, nullptr, &startup, &process) != FALSE, "owned child creation failed");
    }
    ~OwnedChild() {
        if (process.hProcess != nullptr) {
            TerminateProcess(process.hProcess, 0);
            WaitForSingleObject(process.hProcess, 2000);
            CloseHandle(process.hProcess);
        }
        if (process.hThread != nullptr) CloseHandle(process.hThread);
    }
};

int main(int argc, char** argv) {
    if (argc == 2 && std::string_view(argv[1]) == "--owned-child") { Sleep(30000); return 0; }
    try {
        OwnedChild child;
        const auto pid = child.process.dwProcessId;
        const auto identity = runtime::query_process_instance(pid);
        require(identity.state == runtime::ProcessInstanceState::present, "owned child must be present");
        const auto stop = [&](std::uint64_t ticks, const std::string& executable, ULONGLONG deadline) {
            return runtime::stop_process_instance(pid, ticks, executable, deadline);
        };
        require(stop(identity.creation_utc_ticks + 1, identity.executable_path, GetTickCount64() + 2000) == State::reused,
            "birth mismatch must reject termination");
        require(WaitForSingleObject(child.process.hProcess, 0) == WAIT_TIMEOUT, "birth mismatch killed child");
        require(stop(identity.creation_utc_ticks, identity.executable_path + ".wrong", GetTickCount64() + 2000) == State::reused,
            "executable mismatch must reject termination");
        require(WaitForSingleObject(child.process.hProcess, 0) == WAIT_TIMEOUT, "executable mismatch killed child");
        require(stop(identity.creation_utc_ticks, identity.executable_path, GetTickCount64()) == State::deferred,
            "expired native deadline must defer");
        require(WaitForSingleObject(child.process.hProcess, 0) == WAIT_TIMEOUT, "expired budget killed child");
        runtime::ProcessHandle readonly(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
        require(readonly.get() != nullptr, "readonly child handle unavailable");
        require(runtime::stop_process_handle(readonly.get(), pid, identity.creation_utc_ticks,
            identity.executable_path, GetTickCount64() + 2000) == State::unverifiable,
            "missing termination right must be unverifiable");
        require(WaitForSingleObject(child.process.hProcess, 0) == WAIT_TIMEOUT, "readonly handle killed child");
        require(readonly.close(), "readonly handle leaked");
        DWORD before = 0, after = 0;
        require(GetProcessHandleCount(GetCurrentProcess(), &before) != FALSE, "initial handle count failed");
        for (int i = 0; i < 128; ++i) require(stop(identity.creation_utc_ticks + 1, identity.executable_path,
            GetTickCount64() + 2000) == State::reused, "repeated mismatch failed");
        require(GetProcessHandleCount(GetCurrentProcess(), &after) != FALSE && before == after, "stop handle leaked");
        require(stop(identity.creation_utc_ticks, identity.executable_path, GetTickCount64() + 2000) == State::stopped,
            "matched child was not positively stopped");
        require(WaitForSingleObject(child.process.hProcess, 0) == WAIT_OBJECT_0, "stopped reported before positive exit");
        require(stop(identity.creation_utc_ticks, identity.executable_path, GetTickCount64() + 2000) == State::absent,
            "already signaled child must be absent");
        require(runtime::stop_process_instance(0, identity.creation_utc_ticks, identity.executable_path,
            GetTickCount64() + 2000) == State::unverifiable, "invalid PID must fail closed");
        std::cout << "owned-child birth/executable fencing, expired deadline, denied termination, positive exit, absence, handle cleanup passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
