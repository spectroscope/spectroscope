#!/usr/bin/env bash
# Builds every sample against the published Maven Central coordinates and
# runs the ones that work offline. Needs: a Gradle installation (or
# GRADLE=/path/to/gradle), Java 21+, network for the first resolve.
#
# Offline runs use a scratch HOME (via JAVA_TOOL_OPTIONS) so a verify pass
# never writes into your real ~/.spectro session store; running a sample
# by hand per its README uses your real home, which is the point.
set -u
cd "$(dirname "$0")"

GRADLE="${GRADLE:-gradle}"
BUILD_ONLY=(01-five-lines 04-fleet-across-processes 08-langchain4j-provider)
BUILD_AND_RUN=(02-fleet 03-watch 05-otel-export)
# 06 ships a compose file and an installer rather than Java. Its shape is
# asserted by LangfuseComposeDriftTest and LangfuseInstallScriptTest in the
# Gradle suite, including a --configure-only run, so this pass only syntax
# checks the script: starting six containers is not something a verify pass does
# behind your back.
SHELL_ONLY=(06-langfuse)
README_ONLY=(07-phoenix)

failures=0

build() {
    echo "== build $1"
    if ! "$GRADLE" -p "$1" --console=plain -q build; then
        echo "!! BUILD FAILED: $1"
        failures=$((failures + 1))
        return 1
    fi
}

run_offline() {
    echo "== run   $1 (offline, scratch home)"
    local scratch
    scratch="$(mktemp -d)"
    if ! JAVA_TOOL_OPTIONS="-Duser.home=$scratch" \
            "$GRADLE" -p "$1" --console=plain -q run > /dev/null 2>&1; then
        echo "!! RUN FAILED: $1"
        failures=$((failures + 1))
    fi
    rm -rf "$scratch"
}

for dir in "${BUILD_ONLY[@]}"; do
    build "$dir"
done

for dir in "${BUILD_AND_RUN[@]}"; do
    build "$dir" && run_offline "$dir"
done

for dir in "${SHELL_ONLY[@]}"; do
    echo "== check $dir (shell only, no container is started)"
    if ! bash -n "$dir/install.sh"; then
        echo "!! SYNTAX FAILED: $dir/install.sh"
        failures=$((failures + 1))
    fi
done

for dir in "${README_ONLY[@]}"; do
    echo "== skip  $dir (README-only endpoint variant)"
done

echo
if [ "$failures" -eq 0 ]; then
    echo "verify: all samples green"
else
    echo "verify: $failures failure(s)"
    exit 1
fi
