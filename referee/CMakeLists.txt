cmake_minimum_required(VERSION 3.28)
project(uci_arena_evidence_referee LANGUAGES CXX)

get_filename_component(
  UCI_ARENA_REPOSITORY_ROOT
  "${CMAKE_CURRENT_LIST_DIR}/../../.."
  ABSOLUTE
)

add_executable(
  flashfork_complete_game_referee
  "${UCI_ARENA_REPOSITORY_ROOT}/engine/tools/complete_game_referee.cpp"
  "${UCI_ARENA_REPOSITORY_ROOT}/engine/src/core/chess.cpp"
  "${UCI_ARENA_REPOSITORY_ROOT}/engine/src/diagnostics/timing.cpp"
)
target_compile_features(flashfork_complete_game_referee PRIVATE cxx_std_20)
target_compile_definitions(
  flashfork_complete_game_referee
  PRIVATE
    _CRT_SECURE_NO_WARNINGS
    FLASHFORK_ENABLE_TIMING=0
)
target_include_directories(
  flashfork_complete_game_referee
  PRIVATE "${UCI_ARENA_REPOSITORY_ROOT}/engine/include"
)
if(MSVC)
  target_compile_options(
    flashfork_complete_game_referee PRIVATE /W4 /permissive- /EHsc
  )
else()
  target_compile_options(
    flashfork_complete_game_referee PRIVATE -Wall -Wextra -Wpedantic
  )
endif()
