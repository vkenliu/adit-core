#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────
#  ADIT Core — install.sh
#  Detects the system environment, installs required runtimes and
#  libraries, builds the project, and registers the `adit` and
#  `adit-hook` commands.
#
#  Wrap the entire script in { } so bash reads it fully into memory
#  before executing. Without this, `curl | bash` can lose the rest
#  of the script when a sub-command (e.g. nvm, NodeSource) reads
#  from stdin.
# ────────────────────────────────────────────────────────────────────
{
set -euo pipefail

# Catch unexpected exits from set -e and report where it happened
trap 'err "Install failed at line $LINENO (exit code $?). Please report this issue."' ERR

# ── Colours / helpers ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Colour

info()  { printf "${CYAN}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
err()   { printf "${RED}[error]${NC} %s\n" "$*" >&2; }
die()   { err "$*"; exit 1; }

# ── Constants ───────────────────────────────────────────────────────
REQUIRED_NODE_MAJOR=20
REQUIRED_PNPM_MAJOR=9
ADIT_REPO="https://github.com/vkenliu/adit-core.git"
ADIT_INSTALL_DIR="${ADIT_INSTALL_DIR:-$HOME/.adit-core}"

# Resolve the project root. When piped via `curl | bash` BASH_SOURCE
# points nowhere useful, so we clone the repo first.
if [[ -f "$(dirname "${BASH_SOURCE[0]:-/dev/null}")/package.json" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  # Running via curl | bash — clone the repo into ADIT_INSTALL_DIR
  if [[ -d "$ADIT_INSTALL_DIR/.git" ]]; then
    info "Updating existing clone at $ADIT_INSTALL_DIR …"
    git -C "$ADIT_INSTALL_DIR" pull --ff-only 2>/dev/null || true
  else
    info "Cloning adit-core into $ADIT_INSTALL_DIR …"
    git clone "$ADIT_REPO" "$ADIT_INSTALL_DIR"
  fi
  SCRIPT_DIR="$ADIT_INSTALL_DIR"
fi

# ── OS / distro detection ──────────────────────────────────────────
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    *)      die "Unsupported operating system: $OS" ;;
  esac

  DISTRO=""
  PKG_MANAGER=""
  if [[ "$PLATFORM" == "linux" ]]; then
    if   command -v apt-get &>/dev/null; then DISTRO=debian; PKG_MANAGER=apt;
    elif command -v dnf     &>/dev/null; then DISTRO=fedora; PKG_MANAGER=dnf;
    elif command -v yum     &>/dev/null; then DISTRO=rhel;   PKG_MANAGER=yum;
    elif command -v pacman  &>/dev/null; then DISTRO=arch;   PKG_MANAGER=pacman;
    elif command -v apk     &>/dev/null; then DISTRO=alpine; PKG_MANAGER=apk;
    elif command -v zypper  &>/dev/null; then DISTRO=suse;   PKG_MANAGER=zypper;
    else warn "Unknown Linux distribution — will attempt best-effort install"; fi
  fi

  printf "\n${BOLD}System detected${NC}\n"
  printf "  OS:           %s\n" "$OS"
  printf "  Arch:         %s\n" "$ARCH"
  printf "  Platform:     %s\n" "$PLATFORM"
  [[ -n "$DISTRO" ]] && printf "  Distro:       %s\n" "$DISTRO"
  [[ -n "$PKG_MANAGER" ]] && printf "  Pkg manager:  %s\n" "$PKG_MANAGER"
  echo
}

# ── Helper: version comparison ──────────────────────────────────────
# Returns 0 if $1 >= $2 (major-version comparison)
version_ge() {
  local have="$1" need="$2"
  [[ "$have" -ge "$need" ]] 2>/dev/null
}

# ── Git ─────────────────────────────────────────────────────────────
ensure_git() {
  if command -v git &>/dev/null; then
    ok "git $(git --version | awk '{print $3}') found"
    return
  fi
  info "Installing git …"
  case "$PLATFORM" in
    macos)
      # Xcode CLI tools include git
      xcode-select --install 2>/dev/null || true
      ;;
    linux)
      case "$PKG_MANAGER" in
        apt)    sudo apt-get update -qq && sudo apt-get install -y -qq git ;;
        dnf)    sudo dnf install -y git ;;
        yum)    sudo yum install -y git ;;
        pacman) sudo pacman -Sy --noconfirm git ;;
        apk)    sudo apk add --no-cache git ;;
        zypper) sudo zypper install -y git ;;
        *)      die "Cannot install git — unknown package manager" ;;
      esac
      ;;
  esac
  command -v git &>/dev/null || die "git installation failed"
  ok "git installed"
}

# ── Build tools (fallback for native addon compilation) ─────────────
# better-sqlite3 ships prebuilt binaries for most platforms via
# prebuild-install. Build tools are only needed as a fallback when
# prebuilds are unavailable (rare). We check but don't block.
check_build_tools() {
  case "$PLATFORM" in
    macos)
      if xcode-select -p &>/dev/null; then
        ok "Xcode Command Line Tools found (optional — prebuilds preferred)"
      else
        info "Xcode Command Line Tools not installed (not required — prebuilt binaries will be used)"
        info "If native compilation is needed later, run: xcode-select --install"
        HAS_BUILD_TOOLS=false
      fi
      ;;
    linux)
      local missing=()
      command -v python3 &>/dev/null || missing+=(python3)
      command -v make    &>/dev/null || missing+=(make)
      command -v g++     &>/dev/null || command -v c++ &>/dev/null || missing+=(g++)

      if [[ ${#missing[@]} -eq 0 ]]; then
        ok "Build tools found (python3, make, g++)"
      else
        info "Build tools not fully installed: ${missing[*]} (not required — prebuilt binaries will be used)"
        info "If native compilation is needed later, install: ${missing[*]}"
        HAS_BUILD_TOOLS=false
      fi
      ;;
  esac
}

# ── Node.js ─────────────────────────────────────────────────────────
ensure_node() {
  if command -v node &>/dev/null; then
    local node_ver
    node_ver="$(node -v | sed 's/^v//')"
    local node_major="${node_ver%%.*}"
    if version_ge "$node_major" "$REQUIRED_NODE_MAJOR"; then
      ok "Node.js v${node_ver} found (>= ${REQUIRED_NODE_MAJOR} required)"
      return
    else
      warn "Node.js v${node_ver} found but >= ${REQUIRED_NODE_MAJOR} is required"
    fi
  fi

  info "Installing Node.js >= ${REQUIRED_NODE_MAJOR} …"

  # Prefer fnm if available, else nvm, else system package manager
  if command -v fnm &>/dev/null; then
    info "Using fnm …"
    fnm install "$REQUIRED_NODE_MAJOR" && fnm use "$REQUIRED_NODE_MAJOR"
  elif command -v nvm &>/dev/null || [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    info "Using nvm …"
    # shellcheck disable=SC1091
    [[ -s "$HOME/.nvm/nvm.sh" ]] && source "$HOME/.nvm/nvm.sh"
    nvm install "$REQUIRED_NODE_MAJOR" && nvm use "$REQUIRED_NODE_MAJOR"
  else
    # Install via platform package manager or NodeSource
    case "$PLATFORM" in
      macos)
        if command -v brew &>/dev/null; then
          brew install "node@${REQUIRED_NODE_MAJOR}"
          brew link --overwrite "node@${REQUIRED_NODE_MAJOR}" 2>/dev/null || true
        else
          die "Please install Homebrew (https://brew.sh) or Node.js >= ${REQUIRED_NODE_MAJOR} manually"
        fi
        ;;
      linux)
        case "$PKG_MANAGER" in
          apt)
            info "Setting up NodeSource repository …"
            curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
            sudo apt-get install -y -qq nodejs
            ;;
          dnf)
            curl -fsSL "https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
            sudo dnf install -y nodejs
            ;;
          yum)
            curl -fsSL "https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
            sudo yum install -y nodejs
            ;;
          pacman) sudo pacman -Sy --noconfirm nodejs npm ;;
          apk)    sudo apk add --no-cache "nodejs~=${REQUIRED_NODE_MAJOR}" npm ;;
          zypper)
            curl -fsSL "https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
            sudo zypper install -y nodejs
            ;;
          *)
            die "Cannot auto-install Node.js — please install Node.js >= ${REQUIRED_NODE_MAJOR} manually"
            ;;
        esac
        ;;
    esac
  fi

  command -v node &>/dev/null || die "Node.js installation failed"
  local final_ver
  final_ver="$(node -v | sed 's/^v//')"
  local final_major="${final_ver%%.*}"
  version_ge "$final_major" "$REQUIRED_NODE_MAJOR" || die "Node.js v${final_ver} is below the required v${REQUIRED_NODE_MAJOR}"
  ok "Node.js v${final_ver} ready"
}

# ── pnpm ────────────────────────────────────────────────────────────
ensure_pnpm() {
  if command -v pnpm &>/dev/null; then
    local pnpm_ver
    pnpm_ver="$(pnpm -v)"
    local pnpm_major="${pnpm_ver%%.*}"
    if version_ge "$pnpm_major" "$REQUIRED_PNPM_MAJOR"; then
      ok "pnpm v${pnpm_ver} found (>= ${REQUIRED_PNPM_MAJOR} required)"
      return
    else
      warn "pnpm v${pnpm_ver} found but >= ${REQUIRED_PNPM_MAJOR} is required"
    fi
  fi

  info "Installing pnpm …"
  local pnpm_installed=false

  # Try npm first (most reliable), then corepack as fallback.
  # Each method tries without sudo first, then with sudo if needed.
  if command -v npm &>/dev/null; then
    if npm install -g "pnpm@${REQUIRED_PNPM_MAJOR}" 2>/dev/null; then
      pnpm_installed=true
    elif sudo npm install -g "pnpm@${REQUIRED_PNPM_MAJOR}" 2>/dev/null; then
      pnpm_installed=true
    fi
  fi

  if [[ "$pnpm_installed" == "false" ]] && command -v corepack &>/dev/null; then
    if corepack enable 2>/dev/null && corepack prepare "pnpm@${REQUIRED_PNPM_MAJOR}" --activate 2>/dev/null; then
      pnpm_installed=true
    fi
  fi

  if [[ "$pnpm_installed" == "false" ]]; then
    die "Could not install pnpm. Please install it manually: npm install -g pnpm"
  fi

  command -v pnpm &>/dev/null || die "pnpm installation failed"
  local final_ver
  final_ver="$(pnpm -v)"
  ok "pnpm v${final_ver} ready"
}

# ── Install dependencies ───────────────────────────────────────────
install_deps() {
  info "Installing project dependencies …"
  cd "$SCRIPT_DIR"
  if pnpm install --frozen-lockfile 2>/dev/null || pnpm install; then
    ok "Dependencies installed"
  else
    if [[ "${HAS_BUILD_TOOLS:-true}" == "false" ]]; then
      err "Dependency install failed — prebuilt binaries may not be available for your platform."
      err "Install build tools and retry:"
      case "$PLATFORM" in
        macos) err "  xcode-select --install" ;;
        linux) err "  sudo apt-get install -y python3 make g++  (or equivalent)" ;;
      esac
      exit 1
    else
      die "Dependency install failed"
    fi
  fi
}

# ── Build ───────────────────────────────────────────────────────────
build_project() {
  info "Building all packages …"
  cd "$SCRIPT_DIR"
  pnpm build
  ok "Build complete"
}

# ── Register commands ───────────────────────────────────────────────
register_commands() {
  info "Registering adit and adit-hook commands …"
  cd "$SCRIPT_DIR"

  # Determine a bin directory that is already on PATH.
  # On macOS /usr/local/bin is standard; on Linux check common locations.
  local bin_dir=""
  for candidate in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    if echo "$PATH" | tr ':' '\n' | grep -q "^${candidate}$"; then
      bin_dir="$candidate"
      break
    fi
  done

  # Fallback: use ~/.local/bin and add it to the shell profile
  if [[ -z "$bin_dir" ]]; then
    bin_dir="$HOME/.local/bin"
  fi
  mkdir -p "$bin_dir"

  # Resolve absolute paths to the built entry points
  local adit_bin="$SCRIPT_DIR/packages/cli/dist/index.js"
  local hook_bin="$SCRIPT_DIR/packages/hooks/dist/index.js"

  # Verify the built files exist
  [[ -f "$adit_bin" ]] || die "CLI entry point not found at $adit_bin — build may have failed"
  [[ -f "$hook_bin" ]] || die "Hook entry point not found at $hook_bin — build may have failed"

  # Ensure they are executable
  chmod +x "$adit_bin"
  chmod +x "$hook_bin"

  # Create wrapper scripts (avoids symlink issues with Node ESM resolution)
  cat > "$bin_dir/adit" <<EOF
#!/usr/bin/env bash
exec node "$adit_bin" "\$@"
EOF
  chmod +x "$bin_dir/adit"

  cat > "$bin_dir/adit-hook" <<EOF
#!/usr/bin/env bash
exec node "$hook_bin" "\$@"
EOF
  chmod +x "$bin_dir/adit-hook"

  ok "adit     → $bin_dir/adit"
  ok "adit-hook → $bin_dir/adit-hook"

  # If bin_dir is not on PATH, add it to the shell profile automatically
  if ! echo "$PATH" | tr ':' '\n' | grep -q "^${bin_dir}$"; then
    local shell_profile=""
    if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == */zsh ]]; then
      shell_profile="$HOME/.zshrc"
    elif [[ -f "$HOME/.bashrc" ]]; then
      shell_profile="$HOME/.bashrc"
    elif [[ -f "$HOME/.bash_profile" ]]; then
      shell_profile="$HOME/.bash_profile"
    elif [[ -f "$HOME/.profile" ]]; then
      shell_profile="$HOME/.profile"
    fi

    local path_line="export PATH=\"${bin_dir}:\$PATH\""
    if [[ -n "$shell_profile" ]]; then
      # Only add if not already present
      if ! grep -qF "$bin_dir" "$shell_profile" 2>/dev/null; then
        printf '\n# Added by ADIT installer\n%s\n' "$path_line" >> "$shell_profile"
        ok "Added $bin_dir to PATH in $shell_profile"
      fi
      # Also export for the current session
      export PATH="${bin_dir}:$PATH"
    else
      warn "$bin_dir is not in your PATH"
      printf "  Add the following to your shell profile:\n"
      printf "    ${BOLD}%s${NC}\n" "$path_line"
      echo
    fi
  fi
}

# ── Verify installation ────────────────────────────────────────────
verify() {
  echo
  printf "${BOLD}Verifying installation …${NC}\n"
  local all_ok=true

  if command -v adit &>/dev/null; then
    ok "adit command available: $(command -v adit)"
  else
    warn "adit command not found in PATH (you may need to restart your shell)"
    all_ok=false
  fi

  if command -v adit-hook &>/dev/null; then
    ok "adit-hook command available: $(command -v adit-hook)"
  else
    warn "adit-hook command not found in PATH (you may need to restart your shell)"
    all_ok=false
  fi

  echo
  if [[ "$all_ok" == "true" ]]; then
    printf "${GREEN}${BOLD}ADIT Core installed successfully!${NC}\n"
  else
    printf "${YELLOW}${BOLD}ADIT Core built and registered.${NC}\n"
    printf "Restart your shell or run:  ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}\n"
  fi

  echo
  printf "Quick start:\n"
  printf "  ${BOLD}cd <your-project>${NC}\n"
  printf "  ${BOLD}adit init${NC}            # initialize ADIT in a git repo\n"
  printf "  ${BOLD}adit doctor${NC}          # verify the setup\n"
  printf "  ${BOLD}adit list${NC}            # view the timeline\n"
  echo
}

# ── Main ────────────────────────────────────────────────────────────
main() {
  printf "\n${BOLD}╔══════════════════════════════════════════════╗${NC}\n"
  printf "${BOLD}║     ADIT Core — Installer                    ║${NC}\n"
  printf "${BOLD}║     AI Development Intent Tracker            ║${NC}\n"
  printf "${BOLD}╚══════════════════════════════════════════════╝${NC}\n\n"

  HAS_BUILD_TOOLS=true

  detect_platform
  ensure_git
  check_build_tools
  ensure_node
  ensure_pnpm
  install_deps
  build_project
  register_commands
  verify
}

main "$@"
}
