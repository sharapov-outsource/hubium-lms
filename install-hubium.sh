#!/usr/bin/env bash
# Hubium LMS installer — https://github.com/sharapov-outsource/hubium-lms
#
#   curl -fsSLO https://github.com/sharapov-outsource/hubium-lms/releases/latest/download/install-hubium.sh
#   sudo bash install-hubium.sh             # install; asks what it needs to know
#   sudo bash install-hubium.sh upgrade     # upgrade an installation made by this script
#   sudo bash install-hubium.sh enable-nodes  # let local nodes replicate this installation
#   sudo bash install-hubium.sh --node --hub https://lms.example.org --code CODE
#                                           # a local node of a branch (docs/operations.md)
#   bash install-hubium.sh --help
#
# Installs a published release in Docker (any Linux with Docker) or natively with systemd
# (Debian 12/13, Ubuntu 22.04/24.04/26.04). Every question has an option, so it also runs
# unattended with --yes.
set -Eeuo pipefail

# The release this copy installs; the release workflow writes it. A copy taken from the
# repository installs the latest release.
SCRIPT_VERSION="__HUBIUM_VERSION__"
REPO="${HUBIUM_REPO:-sharapov-outsource/hubium-lms}"
LOG=/var/log/hubium-install.log

MODULES_ALL=(assign quiz forum video livesession scorm h5p lti)
declare -A MODULE_INFO=(
  [assign]="Assignments: students hand in files or text, teachers grade them"
  [quiz]="Quizzes from a question bank, graded automatically"
  [forum]="Forums with subscriptions"
  [video]="Video with adaptive quality (adds ffmpeg and a transcoding worker)"
  [livesession]="Live sessions in BigBlueButton or Jitsi"
  [scorm]="SCORM packages"
  [h5p]="H5P interactive content (uploaded as .h5p files)"
  [lti]="External tools over LTI 1.3"
)

# ── options ─────────────────────────────────────────────────────────────────────
ACTION=install
MODE="" VERSION="" DOMAIN="" CONTENT_DOMAIN="" FILES_DOMAIN="" HTTPS="" WEB_PORT=""
MODULES="" LIVE="" BBB_URL="" BBB_SECRET="" JITSI_DOMAIN="" JITSI_APP_ID="" JITSI_APP_SECRET=""
DB="" DATABASE_URL="" STORAGE="" S3_ENDPOINT="" S3_PUBLIC_URL="" S3_REGION="" S3_BUCKET=""
S3_ACCESS_KEY="" S3_SECRET_KEY="" SMTP_URL="" MAIL_FROM="" ADMIN_EMAIL="" ADMIN_PASSWORD=""
DEMO="" ANTIVIRUS="" AI_LOCAL="" EMBEDDINGS_URL="" EMBEDDINGS_MODEL="" PREFIX=/opt/hubium DATA_DIR=/var/lib/hubium CONFIG_DIR=/etc/hubium FROM_DIR=""
IMAGE="" PULL=yes SKIP_PACKAGES=no ASSUME_YES=no DRY_RUN=no BACKUP=""
NODE=no HUB="" NODE_CODE="" HUB_ADDRESS="" HUB_CA="" NODE_TLS="" REPLICATION_HOST="" REPLICATION_PORT=""

usage() {
  cat <<'EOF'
Hubium LMS installer

Usage: sudo bash install-hubium.sh [install|upgrade|enable-nodes] [options]

Without options it asks. With --yes it takes the options and defaults and asks nothing.

General
  --mode docker|native         Docker containers, or systemd services on this system
  --version X.Y.Z              release to install (default: this script's release)
  --yes, -y                    do not ask; fail when something required is missing
  --dry-run                    show what would happen, change nothing
  --help

Site
  --domain HOST                main address, e.g. lms.example.org
  --content-domain HOST        separate host for untrusted SCORM and H5P content
                               (default: content.<domain>)
  --https caddy|none           Caddy with automatic certificates, or your own proxy
  --web-port PORT              where the web server listens on 127.0.0.1 (3000)

Modules (content pages, links, labels and files are always installed)
  --modules all|LIST           comma-separated: assign,quiz,forum,video,livesession,scorm,h5p,lti
  --live-sessions bbb|jitsi|later
  --bbb-url URL --bbb-secret S
  --jitsi-domain HOST [--jitsi-app-id ID --jitsi-app-secret S]

Database
  --db bundled|external        install PostgreSQL here (Docker: a container), or use yours
  --database-url URL           postgresql://user:password@host:5432/db (external)

Files
  --storage fs|s3              on this server, or S3-compatible storage
  --s3-endpoint URL            external S3; without it Docker runs its own (RustFS)
  --files-domain HOST          Docker's own S3: host browsers download from (files.<domain>)
  --s3-public-url URL          external S3: address browsers download from
  --s3-bucket NAME --s3-region R --s3-access-key K --s3-secret-key S
  --antivirus yes|no           scan uploads with ClamAV (about 3 GB of memory); uploads
                               are refused while the scanner is down

AI (the providers themselves are set up later in Administration → AI)
  --ai-local yes|no            Docker: Ollama with bge-m3 for the AI tutor's search
                               (about 2 GB of memory, a 1.2 GB model download)
  --embeddings-url URL         or your own OpenAI-compatible embedding server, e.g.
  --embeddings-model NAME      http://10.0.0.5:11434/v1 and bge-m3 (1024 dimensions)

Mail and first administrator
  --smtp-url URL               smtp://user:password@smtp.example.org:587 (empty: later)
  --mail-from "Name <addr>"
  --admin-email EMAIL
  --admin-password PASSWORD    empty: a random one, shown at the end
  --demo yes|no                sample courses and users for a trial

Paths
  --prefix DIR                 programs, and compose.yml in Docker mode (/opt/hubium)
  --data-dir DIR               files of the native installation (/var/lib/hubium)
  --config-dir DIR             settings of the native installation (/etc/hubium)

Upgrade
  --backup yes|no              dump the database before upgrading (yes)

Local nodes (servers in the networks of branches that keep working without a connection)
  enable-nodes                 in the cloud (Docker, bundled database): the database takes
                               the nodes' replication over TLS
  --replication-host HOST      where nodes reach the database (the main address)
  --replication-port PORT      the database port open to the nodes (5432)
  --node                       install a node here (Docker); the cloud stays the primary
  --hub URL                    the cloud's address, e.g. https://lms.example.org
  --code CODE                  the installation code from Administration → Nodes
  --hub-address HOST[:PORT]    where the cloud is reached when this network's DNS sends its
                               name to the node
  --hub-ca FILE                the certificate (PEM) of the authority that signed the
                               cloud's, when it is not a public one (a company's own CA)
  --node-tls cloud|acme|internal
                               the cloud's names with its certificate (cloud), or the node's
                               own names (--domain, --content-domain) with Let's Encrypt or
                               Caddy's own CA

Testing an unpublished build
  --from-dir DIR               take the archive, compose.yml and Caddyfile from DIR
  --image NAME                 image name instead of ghcr.io/sharapov-outsource/hubium-lms
  --no-pull                    use images already on this machine
  --skip-packages              install no system packages (other distributions)
EOF
}

# --x=y becomes --x y
args=()
for a in "$@"; do
  if [[ $a == --*=* ]]; then args+=("${a%%=*}" "${a#*=}"); else args+=("$a"); fi
done
set -- ${args[@]+"${args[@]}"}
while (($#)); do
  case $1 in
    install | upgrade | enable-nodes | node-update) ACTION=$1 ;;
    --node) NODE=yes ;;
    --hub) HUB=${2-}; shift ;;
    --code) NODE_CODE=${2-}; shift ;;
    --hub-address) HUB_ADDRESS=${2-}; shift ;;
    --hub-ca) HUB_CA=${2-}; shift ;;
    --node-tls) NODE_TLS=${2-}; shift ;;
    --replication-host) REPLICATION_HOST=${2-}; shift ;;
    --replication-port) REPLICATION_PORT=${2-}; shift ;;
    --mode) MODE=${2-}; shift ;;
    --version) VERSION=${2-}; shift ;;
    --domain) DOMAIN=${2-}; shift ;;
    --content-domain) CONTENT_DOMAIN=${2-}; shift ;;
    --files-domain) FILES_DOMAIN=${2-}; shift ;;
    --https) HTTPS=${2-}; shift ;;
    --web-port) WEB_PORT=${2-}; shift ;;
    --modules) MODULES=${2-}; shift ;;
    --live-sessions) LIVE=${2-}; shift ;;
    --bbb-url) BBB_URL=${2-}; shift ;;
    --bbb-secret) BBB_SECRET=${2-}; shift ;;
    --jitsi-domain) JITSI_DOMAIN=${2-}; shift ;;
    --jitsi-app-id) JITSI_APP_ID=${2-}; shift ;;
    --jitsi-app-secret) JITSI_APP_SECRET=${2-}; shift ;;
    --db) DB=${2-}; shift ;;
    --database-url) DATABASE_URL=${2-}; shift ;;
    --storage) STORAGE=${2-}; shift ;;
    --s3-endpoint) S3_ENDPOINT=${2-}; shift ;;
    --s3-public-url) S3_PUBLIC_URL=${2-}; shift ;;
    --s3-bucket) S3_BUCKET=${2-}; shift ;;
    --s3-region) S3_REGION=${2-}; shift ;;
    --s3-access-key) S3_ACCESS_KEY=${2-}; shift ;;
    --s3-secret-key) S3_SECRET_KEY=${2-}; shift ;;
    --antivirus) ANTIVIRUS=${2-}; shift ;;
    --ai-local) AI_LOCAL=${2-}; shift ;;
    --embeddings-url) EMBEDDINGS_URL=${2-}; shift ;;
    --embeddings-model) EMBEDDINGS_MODEL=${2-}; shift ;;
    --smtp-url) SMTP_URL=${2-}; shift ;;
    --mail-from) MAIL_FROM=${2-}; shift ;;
    --admin-email) ADMIN_EMAIL=${2-}; shift ;;
    --admin-password) ADMIN_PASSWORD=${2-}; shift ;;
    --demo) DEMO=${2-}; shift ;;
    --prefix) PREFIX=${2-}; shift ;;
    --data-dir) DATA_DIR=${2-}; shift ;;
    --config-dir) CONFIG_DIR=${2-}; shift ;;
    --from-dir) FROM_DIR=${2-}; shift ;;
    --image) IMAGE=${2-}; shift ;;
    --backup) BACKUP=${2-}; shift ;;
    --no-pull) PULL=no ;;
    --skip-packages) SKIP_PACKAGES=yes ;;
    -y | --yes) ASSUME_YES=yes ;;
    --dry-run) DRY_RUN=yes ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s (see --help)\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

# ── output ──────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\e[1m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' DIM=$'\e[2m' RESET=$'\e[0m'
else
  BOLD="" GREEN="" YELLOW="" RED="" DIM="" RESET=""
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
# a group of questions: a heading only when someone answers them
section() { if interactive; then step "$@"; fi; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '\n%sError:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}
trap 'die "line $LINENO: \"$BASH_COMMAND\" failed. Details: $LOG"' ERR

log() { [[ $DRY_RUN == yes ]] || printf '%s\n' "$*" >>"$LOG"; }

# Runs a command, its output into the log; shows the end of the log when it fails.
run() {
  if [[ $DRY_RUN == yes ]]; then
    printf '  %s$ %s%s\n' "$DIM" "$*" "$RESET"
    return 0
  fi
  log "+ $*"
  if ! "$@" >>"$LOG" 2>&1; then
    printf '%s\n' "--- last lines of $LOG ---" >&2
    tail -n 25 "$LOG" >&2
    die "\"$*\" failed."
  fi
}

# Runs a command with its output on the terminal (long downloads, docker compose).
run_shown() {
  if [[ $DRY_RUN == yes ]]; then
    printf '  %s$ %s%s\n' "$DIM" "$*" "$RESET"
    return 0
  fi
  log "+ $*"
  "$@" || die "\"$*\" failed."
}

# Writes stdin to a file with a mode; prints it instead in a dry run.
write_file() {
  local file=$1 mode=$2 owner=${3:-root:root}
  if [[ $DRY_RUN == yes ]]; then
    printf '  %swrite %s (%s)%s\n' "$DIM" "$file" "$mode" "$RESET"
    cat >/dev/null
    return 0
  fi
  [[ -d $(dirname "$file") ]] || install -d -m 0755 "$(dirname "$file")"
  local tmp
  tmp=$(mktemp "$file.XXXXXX")
  cat >"$tmp"
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f "$tmp" "$file"
}

# ── questions ───────────────────────────────────────────────────────────────────
interactive() {
  [[ $ASSUME_YES == no ]] && { : </dev/tty; } 2>/dev/null
}

# ask VAR "Question" [default] — keeps a value given as an option
ask() {
  local var=$1 question=$2 default=${3-} answer
  [[ -n ${!var} ]] && return 0
  if ! interactive; then
    [[ -n $default ]] || die "$question: give it as an option (see --help)."
    printf -v "$var" '%s' "$default"
    return 0
  fi
  read -r -p "  $question${default:+ [$default]}: " answer </dev/tty || true
  printf -v "$var" '%s' "${answer:-$default}"
}

# ask_optional VAR "Question" — may stay empty
ask_optional() {
  local var=$1 question=$2 answer
  [[ -n ${!var} ]] && return 0
  interactive || return 0
  read -r -p "  $question (Enter to skip): " answer </dev/tty || true
  printf -v "$var" '%s' "$answer"
}

ask_secret() {
  local var=$1 question=$2 answer
  [[ -n ${!var} ]] && return 0
  interactive || return 0
  read -r -s -p "  $question: " answer </dev/tty || true
  printf '\n'
  printf -v "$var" '%s' "$answer"
}

# choose VAR "Question" default value "description" value "description" ...
choose() {
  local var=$1 question=$2 default=$3
  shift 3
  local values=() descriptions=() i answer
  while (($#)); do
    values+=("$1")
    descriptions+=("$2")
    shift 2
  done
  if [[ -n ${!var} ]]; then
    for i in "${values[@]}"; do [[ ${!var} == "$i" ]] && return 0; done
    die "$question: \"${!var}\" is not one of: ${values[*]}."
  fi
  if ! interactive; then
    printf -v "$var" '%s' "$default"
    return 0
  fi
  printf '  %s\n' "$question"
  for i in "${!values[@]}"; do
    printf '    %d) %-10s %s%s\n' "$((i + 1))" "${values[$i]}" "${descriptions[$i]}" \
      "$([[ ${values[$i]} == "$default" ]] && printf ' (default)')"
  done
  while :; do
    read -r -p "  Choice [$default]: " answer </dev/tty || true
    answer=${answer:-$default}
    if [[ $answer =~ ^[0-9]+$ ]] && ((answer >= 1 && answer <= ${#values[@]})); then
      answer=${values[$((answer - 1))]}
    fi
    for i in "${values[@]}"; do
      if [[ $answer == "$i" ]]; then
        printf -v "$var" '%s' "$answer"
        return 0
      fi
    done
    printf '  Please choose one of: %s\n' "${values[*]}"
  done
}

yes_no() { # yes_no VAR "Question" default(yes|no)
  choose "$1" "$2" "$3" yes "" no ""
}

confirm() {
  [[ $ASSUME_YES == yes || $DRY_RUN == yes ]] && return 0
  interactive || return 0
  local answer
  read -r -p "  $1 [Y/n]: " answer </dev/tty || true
  [[ -z $answer || $answer =~ ^[Yy] ]]
}

# ── helpers ─────────────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }
version_ge() { printf '%s\n%s\n' "$2" "$1" | sort -V -C; }
secret() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40; }
has_module() { [[ ",$MODULES," == *",$1,"* ]]; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
mask_url() { sed -E 's#(://[^:/@]*):[^@]*@#\1:***@#' <<<"$1"; }

valid_host() { [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; }
valid_email() { [[ $1 =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }

# Values go into the settings files in single quotes, which both docker compose and Node
# read literally; a value cannot contain a single quote or a newline.
quote() {
  [[ $1 != *"'"* && $1 != *$'\n'* ]] || die "Values cannot contain single quotes: $1"
  printf "'%s'" "$1"
}

port_free() {
  if have ss; then
    [[ -z $(ss -Hltn "sport = :$1" 2>/dev/null) ]]
  elif (: </dev/tcp/127.0.0.1/"$1") 2>/dev/null; then
    return 1
  fi
}

fetch() { # fetch URL FILE
  run curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
}

release_url() { printf 'https://github.com/%s/releases/download/v%s/%s' "$REPO" "$VERSION" "$1"; }

# get_asset NAME DIR: the release file in DIR, checked against SHA256SUMS.
get_asset() {
  local name=$1 dir=$2
  if [[ -n $FROM_DIR ]]; then
    [[ -f $FROM_DIR/$name ]] || die "$FROM_DIR/$name is missing."
    run cp "$FROM_DIR/$name" "$dir/$name"
    [[ -f $FROM_DIR/SHA256SUMS ]] && run cp "$FROM_DIR/SHA256SUMS" "$dir/SHA256SUMS"
  else
    fetch "$(release_url "$name")" "$dir/$name"
    [[ -f $dir/SHA256SUMS ]] || fetch "$(release_url SHA256SUMS)" "$dir/SHA256SUMS"
  fi
  [[ $DRY_RUN == yes ]] && return 0
  if [[ -f $dir/SHA256SUMS ]]; then
    (cd "$dir" && grep " $name\$" SHA256SUMS | sha256sum -c - >>"$LOG" 2>&1) ||
      die "$name does not match its checksum in SHA256SUMS: the download is damaged or altered."
  else
    warn "No SHA256SUMS next to $name: it was not verified."
  fi
}

load_os() {
  OS_ID="" OS_VERSION="" OS_CODENAME="" OS_NAME="$(uname -s)" OS_LIKE=""
  [[ -r /etc/os-release ]] || return 0
  # read in a subshell: os-release defines VERSION, NAME and others this script uses
  eval "$(
    # shellcheck disable=SC1091
    . /etc/os-release
    printf 'OS_ID=%q OS_VERSION=%q OS_CODENAME=%q OS_NAME=%q OS_LIKE=%q\n' \
      "${ID-}" "${VERSION_ID-}" "${VERSION_CODENAME-}" "${PRETTY_NAME:-${ID-}}" "${ID_LIKE-}"
  )"
}

apt_based() { have apt-get && [[ $OS_ID == debian || $OS_ID == ubuntu || $OS_LIKE == *debian* ]]; }

native_supported() {
  case "$OS_ID:$OS_VERSION" in
    debian:12 | debian:13 | ubuntu:22.04 | ubuntu:24.04 | ubuntu:26.04) return 0 ;;
    *) return 1 ;;
  esac
}

apt_install() {
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

APT_UPDATED=no
apt_update() {
  [[ $APT_UPDATED == yes ]] && return 0
  run env DEBIAN_FRONTEND=noninteractive apt-get update
  APT_UPDATED=yes
}

# ── checks ──────────────────────────────────────────────────────────────────────
preflight() {
  step "Checking this server"
  [[ $(uname -s) == Linux ]] || die "Hubium installs on Linux servers."
  ((BASH_VERSINFO[0] >= 4)) || die "bash 4 or newer is needed."
  if [[ $EUID -ne 0 && $DRY_RUN == no ]]; then
    die "Run it as root: sudo bash $0 ${ACTION}"
  fi
  [[ $DRY_RUN == yes ]] || { : >>"$LOG"; } 2>/dev/null || LOG=/tmp/hubium-install.log
  log "=== $(date -u +%FT%TZ) install-hubium.sh $ACTION"
  case $(uname -m) in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "Unsupported processor $(uname -m): x86_64 and aarch64 are supported." ;;
  esac
  load_os
  ok "$OS_NAME, $(uname -m)"
  for tool in curl tar gzip sha256sum awk sed grep base64; do
    have "$tool" || die "$tool is missing. Install it (apt-get install curl tar gzip coreutils) and run again."
  done
  ok "curl, tar and coreutils found"
  local parent=$PREFIX
  while [[ ! -d $parent ]]; do parent=$(dirname "$parent"); done
  local free_mb min_mb=3072
  # an upgrade only adds a release and a database dump next to what is there
  [[ $ACTION == upgrade ]] && min_mb=1024
  free_mb=$(df -Pm "$parent" | awk 'NR == 2 { print $4 }')
  if ((free_mb < min_mb)); then
    die "Only ${free_mb} MB free on $parent; at least $((min_mb / 1024)) GB are needed, 10 GB or more for courses and video."
  elif ((free_mb < 10240)); then
    warn "${free_mb} MB free on $parent: enough to install, but courses and video need more."
  else
    ok "$((free_mb / 1024)) GB free on $parent"
  fi
  local mem_mb
  mem_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
  if ((mem_mb < 1900)); then
    warn "${mem_mb} MB of memory: 2 GB is the minimum, 4 GB with video transcoding."
  else
    ok "${mem_mb} MB of memory"
  fi
  log "arch=$ARCH os=$OS_ID $OS_VERSION mem=${mem_mb}MB free=${free_mb}MB"
}

resolve_version() {
  if [[ -z $VERSION && $SCRIPT_VERSION != __* ]]; then VERSION=$SCRIPT_VERSION; fi
  if [[ -z $VERSION && -n $FROM_DIR ]]; then
    local archive
    archive=$(find "$FROM_DIR" -maxdepth 1 -name "hubium-*-linux-$ARCH.tar.gz" -print -quit)
    if [[ -n $archive ]]; then
      VERSION=$(basename "$archive")
      VERSION=${VERSION#hubium-}
      VERSION=${VERSION%-linux-"$ARCH".tar.gz}
    fi
  fi
  if [[ -z $VERSION ]]; then
    local url
    url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") ||
      die "Cannot reach github.com to find the latest release; give --version."
    VERSION=${url##*/}
  fi
  VERSION=${VERSION#v}
  [[ $VERSION =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || die "Not a release version: $VERSION"
}

check_docker() {
  if ! have docker; then
    if apt_based && [[ $SKIP_PACKAGES == no ]]; then
      warn "Docker is not installed."
      confirm "Install Docker Engine from Docker's official repository?" ||
        die "Install Docker (https://docs.docker.com/engine/install/) and run again."
      install_docker
    else
      die "Docker is not installed: https://docs.docker.com/engine/install/"
    fi
  fi
  [[ $DRY_RUN == yes ]] && ! have docker && return 0
  docker info >/dev/null 2>&1 || die "Docker is installed but not running (systemctl start docker)."
  local engine compose
  engine=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0)
  version_ge "$engine" 24.0 || die "Docker $engine is too old; 24 or newer is needed."
  compose=$(docker compose version --short 2>/dev/null || echo 0)
  compose=${compose#v}
  version_ge "$compose" 2.20 || die "Docker Compose $compose is too old (or missing); 2.20 or newer is needed (docker-compose-plugin)."
  ok "Docker $engine, Compose $compose"
}

install_docker() {
  step "Installing Docker Engine"
  apt_update
  apt_install ca-certificates curl
  run install -m 0755 -d /etc/apt/keyrings
  local distro=$OS_ID
  [[ $distro == ubuntu || $distro == debian ]] || distro=debian
  fetch "https://download.docker.com/linux/$distro/gpg" /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$distro" "$OS_CODENAME" | write_file /etc/apt/sources.list.d/docker.list 0644
  APT_UPDATED=no
  apt_update
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run systemctl enable --now docker
  ok "Docker installed"
}

check_native() {
  if [[ ! -d /run/systemd/system ]]; then
    [[ $DRY_RUN == yes ]] || die "The native installation needs systemd; use --mode docker."
    warn "No systemd here (dry run continues)."
  fi
  local glibc
  glibc=$(ldd --version 2>/dev/null | awk 'NR == 1 { print $NF }')
  version_ge "${glibc:-0}" 2.28 || die "glibc ${glibc:-unknown} is too old (2.28+, e.g. Debian 10+); use --mode docker."
  if [[ $SKIP_PACKAGES == no ]]; then
    apt_based || die "This system has no apt. Install PostgreSQL 16+ with pgvector, Caddy and ffmpeg yourself and run with --skip-packages, or use --mode docker."
    native_supported || warn "$OS_NAME is not among the tested systems (Debian 12/13, Ubuntu 22.04/24.04/26.04)."
  fi
  ok "systemd, glibc $glibc"
}

# ── questions ───────────────────────────────────────────────────────────────────
ask_everything() {
  section "Installation"
  local docker_hint="any Linux; Docker is installed if missing"
  have docker && docker_hint="Docker is installed"
  choose MODE "How should Hubium run?" docker \
    docker "in Docker containers ($docker_hint)" \
    native "as systemd services on this system (Debian, Ubuntu)"

  section "Site"
  while :; do
    ask DOMAIN "Main address of the site (e.g. lms.example.org)"
    DOMAIN=$(lower "${DOMAIN#https://}")
    DOMAIN=${DOMAIN%/}
    valid_host "$DOMAIN" && break
    [[ $ASSUME_YES == yes ]] && die "--domain: \"$DOMAIN\" is not a host name."
    printf '  "%s" is not a host name.\n' "$DOMAIN"
    DOMAIN=""
  done
  local base=${DOMAIN#*.}
  [[ $DOMAIN == *.localhost || $base != *.* ]] && base=$DOMAIN
  [[ $DOMAIN == *.localhost ]] && base=localhost
  ask CONTENT_DOMAIN "Separate host for untrusted SCORM and H5P content" "content.$base"
  CONTENT_DOMAIN=$(lower "${CONTENT_DOMAIN#https://}")
  valid_host "$CONTENT_DOMAIN" || die "Not a host name: $CONTENT_DOMAIN"
  [[ $CONTENT_DOMAIN != "$DOMAIN" ]] || die "The content host must differ from the main address."
  choose HTTPS "HTTPS" caddy \
    caddy "Caddy gets and renews certificates (ports 80 and 443)" \
    none "my own reverse proxy forwards to 127.0.0.1"
  ask WEB_PORT "Port of the web server on 127.0.0.1" 3000
  [[ $WEB_PORT =~ ^[0-9]+$ ]] || die "--web-port: not a port number."

  section "Modules"
  if [[ -z $MODULES ]] && interactive; then
    note "Content (pages, links, labels, files) is always installed. Activities:"
    local m
    for m in "${MODULES_ALL[@]}"; do printf '    %-12s %s\n' "$m" "${MODULE_INFO[$m]}"; done
  fi
  ask MODULES "Activities to install (all, or a list like quiz,assign,forum)" all
  MODULES=$(lower "${MODULES// /,}")
  if [[ $MODULES == all ]]; then
    MODULES=$(IFS=,; printf '%s' "${MODULES_ALL[*]}")
  else
    local list=() m
    IFS=, read -r -a list <<<"$MODULES"
    MODULES=""
    for m in "${list[@]}"; do
      [[ -z $m ]] && continue
      [[ -n ${MODULE_INFO[$m]-} ]] || die "Unknown module \"$m\"; known: ${MODULES_ALL[*]}."
      MODULES+="${MODULES:+,}$m"
    done
  fi
  if has_module livesession; then
    choose LIVE "Live sessions run in" later \
      bbb "a BigBlueButton server" \
      jitsi "Jitsi Meet (meet.jit.si or your own)" \
      later "set it up later in the settings file"
    if [[ $LIVE == bbb ]]; then
      ask BBB_URL "BigBlueButton URL (https://bbb.example.org/bigbluebutton/)"
      ask_secret BBB_SECRET "BigBlueButton shared secret"
    elif [[ $LIVE == jitsi ]]; then
      ask JITSI_DOMAIN "Jitsi domain" meet.jit.si
      ask_optional JITSI_APP_ID "Jitsi JWT app id"
      [[ -z $JITSI_APP_ID ]] || ask_secret JITSI_APP_SECRET "Jitsi JWT app secret"
    fi
  fi

  section "Database"
  choose DB "PostgreSQL" bundled \
    bundled "$([[ $MODE == docker ]] && echo "a container with PostgreSQL 18 and pgvector" || echo "install PostgreSQL with pgvector on this server")" \
    external "an existing server (16 or newer, pgvector available)"
  if [[ $DB == external ]]; then
    ask DATABASE_URL "Connection string (postgresql://user:password@host:5432/database)"
    [[ $DATABASE_URL == postgres://* || $DATABASE_URL == postgresql://* ]] ||
      die "The connection string must start with postgresql://"
  fi

  section "Files"
  choose STORAGE "Where uploaded files are kept" fs \
    fs "on this server" \
    s3 "S3-compatible storage$([[ $MODE == docker ]] && echo " (a RustFS container, or yours)")"
  if [[ $STORAGE == s3 ]]; then
    if [[ $MODE == native ]]; then
      ask S3_ENDPOINT "S3 endpoint (https://storage.example.org)"
    else
      ask_optional S3_ENDPOINT "Your S3 endpoint (empty: run RustFS here)"
    fi
    if [[ -n $S3_ENDPOINT ]]; then
      ask S3_PUBLIC_URL "Address browsers download files from" "$S3_ENDPOINT"
      ask S3_BUCKET "Bucket" hubium
      ask S3_REGION "Region" us-east-1
      ask S3_ACCESS_KEY "Access key"
      ask_secret S3_SECRET_KEY "Secret key"
      [[ -n $S3_SECRET_KEY ]] || die "The S3 secret key is required (--s3-secret-key)."
    else
      ask FILES_DOMAIN "Host browsers download files from" "files.$base"
      FILES_DOMAIN=$(lower "${FILES_DOMAIN#https://}")
      valid_host "$FILES_DOMAIN" || die "Not a host name: $FILES_DOMAIN"
      S3_PUBLIC_URL="https://$FILES_DOMAIN"
    fi
  fi
  yes_no ANTIVIRUS "Scan uploaded files for viruses with ClamAV (about 3 GB of memory)?" no
  if [[ $ANTIVIRUS == yes ]] && (($(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo) < 3800)); then
    warn "ClamAV holds its signatures in memory (about 1.5 GB, twice that while updating): 4 GB or more is advised."
  fi

  section "AI search"
  if [[ $MODE == docker && -z $EMBEDDINGS_URL ]]; then
    yes_no AI_LOCAL "Run the bge-m3 embedding model here for the AI tutor's search (Ollama, about 2 GB of memory)?" no
  else
    [[ $AI_LOCAL == yes && $MODE == native ]] &&
      die "--ai-local needs --mode docker; give your embedding server with --embeddings-url instead."
    AI_LOCAL=no
  fi
  if [[ $AI_LOCAL == no ]]; then
    ask_optional EMBEDDINGS_URL "Your OpenAI-compatible embedding server (http://host:11434/v1)"
    if [[ -n $EMBEDDINGS_URL ]]; then
      [[ $EMBEDDINGS_URL == http://* || $EMBEDDINGS_URL == https://* ]] ||
        die "--embeddings-url must start with http:// or https://"
      ask EMBEDDINGS_MODEL "Embedding model (1024 dimensions)" bge-m3
    fi
  fi

  section "Mail"
  ask_optional SMTP_URL "SMTP server (smtp://user:password@smtp.example.org:587)"
  if [[ -n $SMTP_URL ]]; then
    ask MAIL_FROM "Sender" "Hubium LMS <no-reply@$base>"
  fi

  section "First administrator"
  while :; do
    ask ADMIN_EMAIL "Email (also the login)"
    valid_email "$ADMIN_EMAIL" && break
    [[ $ASSUME_YES == yes ]] && die "--admin-email: not an email address."
    ADMIN_EMAIL=""
  done
  ask_secret ADMIN_PASSWORD "Password (Enter for a random one)"
  GENERATED_PASSWORD=no
  if [[ -z $ADMIN_PASSWORD ]]; then
    ADMIN_PASSWORD=$(secret | head -c 20)
    GENERATED_PASSWORD=yes
  fi
  ((${#ADMIN_PASSWORD} >= 8)) || die "The password needs at least 8 characters."
  yes_no DEMO "Add sample courses and users for a trial?" no
}

check_site() {
  step "Checking ports and names"
  if [[ $HTTPS == caddy ]]; then
    local p
    for p in 80 443; do
      if ! port_free "$p"; then
        if [[ $MODE == native ]] && systemctl is-active --quiet caddy 2>/dev/null; then
          note "Port $p: Caddy is already running; its configuration is extended."
        else
          die "Port $p is in use. Stop the service that holds it, or use --https none behind your own proxy."
        fi
      fi
    done
    ok "ports 80 and 443 are free"
  fi
  local ports=("$WEB_PORT")
  [[ $MODE == native ]] && ports+=(3001 3002)
  for p in "${ports[@]}"; do
    port_free "$p" || die "Port $p on 127.0.0.1 is in use$([[ $p == "$WEB_PORT" ]] && echo "; choose another with --web-port")."
  done
  ok "port $WEB_PORT is free"
  local host
  for host in "$DOMAIN" "$CONTENT_DOMAIN" ${FILES_DOMAIN:+"$FILES_DOMAIN"}; do
    [[ $host == *.localhost || $host == localhost ]] && continue
    if getent ahosts "$host" >/dev/null 2>&1; then
      ok "$host resolves to $(getent ahosts "$host" | awk 'NR == 1 { print $1 }')"
    else
      warn "$host does not resolve yet. Point it at this server before people sign in$([[ $HTTPS == caddy ]] && echo "; Caddy gets its certificate once it does")."
    fi
  done
}

summary() {
  step "Summary"
  note "Hubium LMS $VERSION, $([[ $MODE == docker ]] && echo "in Docker" || echo "native with systemd")"
  note "Site:        https://$DOMAIN (content: https://$CONTENT_DOMAIN)"
  note "HTTPS:       $([[ $HTTPS == caddy ]] && echo "Caddy" || echo "your proxy → 127.0.0.1:$WEB_PORT")"
  note "Modules:     content, ${MODULES//,/, }"
  if [[ $DB == bundled ]]; then
    note "Database:    PostgreSQL on this server"
  else
    note "Database:    $(mask_url "$DATABASE_URL")"
  fi
  if [[ $STORAGE == fs ]]; then
    note "Files:       on this server"
  else
    note "Files:       S3 ${S3_ENDPOINT:-(a RustFS container)}"
  fi
  if [[ -n $SMTP_URL ]]; then
    note "Mail:        $(mask_url "$SMTP_URL")"
  else
    note "Mail:        not configured$([[ $MODE == docker ]] && echo " (caught by Mailpit)")"
  fi
  note "Antivirus:   $([[ $ANTIVIRUS == yes ]] && echo "ClamAV scans uploads" || echo "none")"
  if [[ $AI_LOCAL == yes ]]; then
    note "AI search:   bge-m3 in an Ollama container"
  elif [[ -n $EMBEDDINGS_URL ]]; then
    note "AI search:   $EMBEDDINGS_MODEL at $(mask_url "$EMBEDDINGS_URL")"
  fi
  note "Admin:       $ADMIN_EMAIL"
  note "Demo data:   $DEMO"
  note "Paths:       $PREFIX$([[ $MODE == native ]] && echo ", $CONFIG_DIR, $DATA_DIR")"
  confirm "Install now?" || die "Nothing was changed."
}

disabled_modules() {
  local m out=""
  for m in "${MODULES_ALL[@]}"; do has_module "$m" || out+="${out:+,}$m"; done
  printf '%s' "$out"
}

# ── Docker ──────────────────────────────────────────────────────────────────────
dc() {
  local files=(-f "$PREFIX/compose.yml")
  # after enable-nodes: the database takes the nodes' replication
  [[ -f $PREFIX/node/cloud.yml ]] && files+=(-f "$PREFIX/node/cloud.yml")
  docker compose --project-directory "$PREFIX" "${files[@]}" --env-file "$PREFIX/.env" "$@"
}

docker_env() {
  local profiles=caddy
  [[ $HTTPS == caddy ]] || profiles=""
  [[ $DB == bundled ]] && profiles+="${profiles:+,}db"
  [[ $STORAGE == s3 && -z $S3_ENDPOINT ]] && profiles+="${profiles:+,}s3"
  has_module video && profiles+="${profiles:+,}media"
  [[ -z $SMTP_URL ]] && profiles+="${profiles:+,}mailpit"
  [[ $ANTIVIRUS == yes ]] && profiles+="${profiles:+,}clamav"
  [[ $AI_LOCAL == yes ]] && profiles+="${profiles:+,}ai-local"
  {
    echo "# Hubium LMS — written by install-hubium.sh. See .env.production.example for every setting;"
    echo "# after a change: docker compose --project-directory $PREFIX up -d"
    echo "HUBIUM_VERSION=$(quote "$VERSION")"
    [[ -n $IMAGE ]] && echo "HUBIUM_IMAGE=$(quote "$IMAGE")"
    echo "COMPOSE_PROFILES=$(quote "$profiles")"
    echo "APP_URL=$(quote "https://$DOMAIN")"
    echo "CONTENT_HOST=$(quote "https://$CONTENT_DOMAIN")"
    echo "HUBIUM_WEB_BIND=$(quote "127.0.0.1:$WEB_PORT")"
    echo "APP_SECRET=$(quote "$(secret)")"
    if [[ $DB == bundled ]]; then
      echo "POSTGRES_PASSWORD=$(quote "$(secret)")"
    else
      echo "DATABASE_URL=$(quote "$DATABASE_URL")"
    fi
    echo "STORAGE_DRIVER=$(quote "$STORAGE")"
    if [[ $STORAGE == s3 ]]; then
      echo "S3_PUBLIC_URL=$(quote "$S3_PUBLIC_URL")"
      if [[ -n $S3_ENDPOINT ]]; then
        echo "S3_ENDPOINT=$(quote "$S3_ENDPOINT")"
        echo "S3_BUCKET=$(quote "$S3_BUCKET")"
        echo "S3_REGION=$(quote "$S3_REGION")"
        echo "S3_ACCESS_KEY=$(quote "$S3_ACCESS_KEY")"
        echo "S3_SECRET_KEY=$(quote "$S3_SECRET_KEY")"
      else
        echo "S3_SECRET_KEY=$(quote "$(secret)")"
      fi
    fi
    [[ -n $SMTP_URL ]] && echo "SMTP_URL=$(quote "$SMTP_URL")"
    [[ -n $MAIL_FROM ]] && echo "MAIL_FROM=$(quote "$MAIL_FROM")"
    [[ $ANTIVIRUS == yes ]] && echo "CLAMAV_URL='tcp://clamav:3310'"
    embeddings_env "$([[ $AI_LOCAL == yes ]] && echo ollama)"
    live_env
    echo "SEED_PROFILE=$(quote "$([[ $DEMO == yes ]] && echo demo || echo minimal)")"
    echo "SEED_ADMIN_EMAIL=$(quote "$ADMIN_EMAIL")"
    echo "SEED_ADMIN_PASSWORD=$(quote "$ADMIN_PASSWORD")"
  }
}

# The embedding endpoint the first start configures, and its host allowed past the SSRF
# guard when it is internal (Ollama in compose, a server on the LAN or this machine).
embeddings_env() {
  local url=$EMBEDDINGS_URL model=$EMBEDDINGS_MODEL host
  if [[ $1 == ollama ]]; then url=http://ollama:11434/v1 model=bge-m3; fi
  [[ -n $url ]] || return 0
  echo "AI_EMBEDDINGS_URL=$(quote "$url")"
  echo "AI_EMBEDDINGS_MODEL=$(quote "${model:-bge-m3}")"
  host=$(sed -E 's#^[a-z]+://([^/:]+|\[[^]]+\]).*#\1#' <<<"$url")
  # a name without dots (a compose service) or an IP literal; a DNS name of your network
  # that resolves to an internal address has to be added to SSRF_ALLOW_HOSTS by hand
  if [[ $host != *.* || $host =~ ^[0-9.]+$ || $host == \[* ]]; then
    echo "SSRF_ALLOW_HOSTS=$(quote "${host//[\[\]]/}")"
  fi
}

live_env() {
  [[ -n $BBB_URL ]] && echo "BBB_URL=$(quote "$BBB_URL")"
  [[ -n $BBB_SECRET ]] && echo "BBB_SECRET=$(quote "$BBB_SECRET")"
  [[ -n $JITSI_DOMAIN ]] && echo "JITSI_DOMAIN=$(quote "$JITSI_DOMAIN")"
  [[ -n $JITSI_APP_ID ]] && echo "JITSI_APP_ID=$(quote "$JITSI_APP_ID")"
  [[ -n $JITSI_APP_SECRET ]] && echo "JITSI_APP_SECRET=$(quote "$JITSI_APP_SECRET")"
  return 0
}

# Drops the first administrator's password once the administrator exists.
forget_admin_password() {
  local file=$1
  [[ $DRY_RUN == yes || ! -f $file ]] && return 0
  sed -i '/^SEED_ADMIN_PASSWORD=/d' "$file"
}

install_docker_mode() {
  step "Preparing $PREFIX"
  [[ -f $PREFIX/.env ]] && die "$PREFIX/.env exists: Hubium is installed here. Upgrade with: sudo bash $0 upgrade"
  run install -d -m 0750 "$PREFIX"
  get_asset compose.yml "$PREFIX"
  get_asset Caddyfile "$PREFIX"
  docker_env | write_file "$PREFIX/.env" 0600
  ok "compose.yml, Caddyfile and .env in $PREFIX"

  if [[ $PULL == yes ]]; then
    step "Downloading the images"
    run_shown dc pull --quiet
  fi
  if [[ $DB == external ]]; then
    step "Checking the database"
    if [[ $DRY_RUN == no ]]; then
      dc run --rm --no-deps migrate doctor db || (($? == 2)) ||
        die "Fix the database as shown above and run the installer again (remove $PREFIX first)."
    fi
  fi
  local off
  off=$(disabled_modules)
  if [[ -n $off ]]; then
    step "Turning off the activities not chosen: ${off//,/, }"
    run_shown dc run --rm migrate migrate --seed none --disable-modules "$off"
  fi
  step "Starting Hubium"
  run_shown dc up -d --wait --wait-timeout 600
  forget_admin_password "$PREFIX/.env"
  [[ $DRY_RUN == yes ]] || dc ps
}

# ── native ──────────────────────────────────────────────────────────────────────
PGPORT=5432

install_packages() {
  [[ $SKIP_PACKAGES == yes ]] && return 0
  step "Installing system packages"
  apt_update
  apt_install ca-certificates curl gnupg tar gzip
  if [[ $DB == bundled ]]; then install_postgres; fi
  if has_module video; then
    apt_install ffmpeg
    ok "ffmpeg $(ffmpeg -version 2>/dev/null | awk 'NR == 1 { print $3 }' || true)"
  fi
  if [[ $ANTIVIRUS == yes ]]; then install_clamav; fi
  if [[ $HTTPS == caddy ]] && ! have caddy; then
    run install -m 0755 -d /usr/share/keyrings
    fetch https://dl.cloudsmith.io/public/caddy/stable/gpg.key /tmp/caddy-stable.key
    run gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/caddy-stable.key
    run rm -f /tmp/caddy-stable.key
    fetch https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt /etc/apt/sources.list.d/caddy-stable.list
    APT_UPDATED=no
    apt_update
    apt_install caddy
    ok "Caddy $(caddy version 2>/dev/null | awk '{ print $1 }' || true)"
  fi
}

# ClamAV from the distribution: freshclam keeps the signatures current, clamd listens on a
# local socket. Its stream limits are raised above CLAMAV_MAX_SCAN_MB (100 MB).
CLAMD_SOCKET=/run/clamav/clamd.ctl
install_clamav() {
  apt_install clamav-daemon clamav-freshclam
  local conf=/etc/clamav/clamd.conf key value
  if [[ $DRY_RUN == no ]]; then
    for key in StreamMaxLength:110M MaxFileSize:110M MaxScanSize:400M; do
      value=${key#*:} key=${key%%:*}
      if grep -q "^$key " "$conf"; then sed -i "s/^$key .*/$key $value/" "$conf"; else echo "$key $value" >>"$conf"; fi
    done
    CLAMD_SOCKET=$(awk '$1 == "LocalSocket" { print $2; exit }' "$conf")
    CLAMD_SOCKET=${CLAMD_SOCKET:-/run/clamav/clamd.ctl}
  fi
  # clamd starts once freshclam has downloaded the signatures (a few hundred MB)
  step "Waiting for the virus signatures"
  if [[ $DRY_RUN == no ]]; then
    local i
    for ((i = 0; i < 120; i++)); do
      compgen -G '/var/lib/clamav/main.c[vl]d' >/dev/null && compgen -G '/var/lib/clamav/daily.c[vl]d' >/dev/null && break
      sleep 5
    done
    ((i < 120)) || die "freshclam did not download the signatures (journalctl -u clamav-freshclam)."
    run systemctl enable clamav-daemon
    run systemctl restart clamav-daemon
    for ((i = 0; i < 60; i++)); do
      [[ -S $CLAMD_SOCKET ]] && break
      sleep 2
    done
    ((i < 60)) || die "clamd does not listen on $CLAMD_SOCKET (journalctl -u clamav-daemon)."
  fi
  ok "ClamAV $(clamd --version 2>/dev/null | awk '{ print $2 }' | cut -d/ -f1 || true) on $CLAMD_SOCKET"
}

# PostgreSQL: a running cluster of version 16+ if there is one, else 18 from the
# PostgreSQL project's repository; pgvector for it either way.
install_postgres() {
  local cluster="" ver=""
  if have pg_lsclusters; then
    cluster=$(pg_lsclusters -h 2>/dev/null | awk '$4 == "online" && $1 >= 16 { print $1, $3 }' | sort -n | tail -1 || true)
  fi
  if [[ -n $cluster ]]; then
    ver=${cluster% *}
    PGPORT=${cluster#* }
    ok "PostgreSQL $ver is running on port $PGPORT"
    if ! dpkg -s "postgresql-$ver-pgvector" >/dev/null 2>&1; then
      if ! apt-cache show "postgresql-$ver-pgvector" >/dev/null 2>&1; then add_pgdg; fi
      apt_install "postgresql-$ver-pgvector"
    fi
  else
    add_pgdg
    apt_install postgresql-18 postgresql-18-pgvector
    ver=18
    # the package creates the main cluster unless createcluster.conf says otherwise
    if [[ $DRY_RUN == no ]] && ! pg_lsclusters -h 2>/dev/null | awk '$1 == 18 && $2 == "main"' | grep -q .; then
      run pg_createcluster 18 main
    fi
    PGPORT=$(pg_lsclusters -h 2>/dev/null | awk '$1 == 18 && $2 == "main" { print $3; exit }' || true)
    PGPORT=${PGPORT:-5432}
    run systemctl enable --now postgresql@18-main
  fi
  if [[ $DRY_RUN == no ]]; then
    local i
    for ((i = 0; i < 30; i++)); do
      runuser -u postgres -- pg_isready -q -p "$PGPORT" 2>/dev/null && break
      sleep 1
    done
    ((i < 30)) || die "PostgreSQL $ver does not answer on port $PGPORT (journalctl -u postgresql@$ver-main)."
  fi
  ok "PostgreSQL $ver with pgvector"
}

add_pgdg() {
  apt_install postgresql-common
  run /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  APT_UPDATED=yes
}

psql_admin() { (cd /tmp && runuser -u postgres -- psql -p "$PGPORT" -v ON_ERROR_STOP=1 -qtA "$@"); }

create_database() {
  [[ $DB == bundled ]] || return 0
  step "Creating the database"
  local password
  password=$(secret)
  if [[ $DRY_RUN == yes ]]; then
    note "(dry run) role and database hubium with vector, citext, pg_trgm and unaccent"
    DATABASE_URL="postgresql://hubium:***@127.0.0.1:$PGPORT/hubium"
    return 0
  fi
  if [[ $(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = 'hubium'") == 1 ]]; then
    local tables
    tables=$(psql_admin -d hubium -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
    ((tables == 0)) || die "PostgreSQL already has a database \"hubium\" with tables. Upgrade an installation with \"$0 upgrade\", or drop the database first."
  fi
  if [[ $(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname = 'hubium'") == 1 ]]; then
    psql_admin -c "ALTER ROLE hubium WITH LOGIN PASSWORD '$password'" >>"$LOG"
  else
    psql_admin -c "CREATE ROLE hubium WITH LOGIN PASSWORD '$password'" >>"$LOG"
  fi
  if [[ $(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = 'hubium'") != 1 ]]; then
    psql_admin -c "CREATE DATABASE hubium OWNER hubium ENCODING 'UTF8' TEMPLATE template0" >>"$LOG"
  fi
  local ext
  for ext in vector citext pg_trgm unaccent; do
    psql_admin -d hubium -c "CREATE EXTENSION IF NOT EXISTS \"$ext\"" >>"$LOG"
  done
  DATABASE_URL="postgresql://hubium:$password@127.0.0.1:$PGPORT/hubium"
  ok "database hubium on port $PGPORT"
}

native_env() {
  echo "# Hubium LMS — written by install-hubium.sh; deploy/hubium.env.example in the release"
  echo "# describes every setting. After a change: systemctl restart hubium-web hubium-worker"
  echo "NODE_ENV='production'"
  echo "APP_URL=$(quote "https://$DOMAIN")"
  echo "CONTENT_HOST=$(quote "https://$CONTENT_DOMAIN")"
  echo "HOSTNAME='127.0.0.1'"
  echo "PORT=$(quote "$WEB_PORT")"
  echo "DATABASE_URL=$(quote "$DATABASE_URL")"
  echo "APP_SECRET=$(quote "$(secret)")"
  echo "STORAGE_DRIVER=$(quote "$STORAGE")"
  # local files, and with S3 the unfinished uploads
  echo "STORAGE_FS_ROOT=$(quote "$DATA_DIR/files")"
  if [[ $STORAGE == s3 ]]; then
    echo "S3_ENDPOINT=$(quote "$S3_ENDPOINT")"
    echo "S3_PUBLIC_URL=$(quote "$S3_PUBLIC_URL")"
    echo "S3_BUCKET=$(quote "$S3_BUCKET")"
    echo "S3_REGION=$(quote "$S3_REGION")"
    echo "S3_ACCESS_KEY=$(quote "$S3_ACCESS_KEY")"
    echo "S3_SECRET_KEY=$(quote "$S3_SECRET_KEY")"
  fi
  [[ -n $SMTP_URL ]] && echo "SMTP_URL=$(quote "$SMTP_URL")"
  [[ -n $MAIL_FROM ]] && echo "MAIL_FROM=$(quote "$MAIL_FROM")"
  [[ $ANTIVIRUS == yes ]] && echo "CLAMAV_URL=$(quote "unix://$CLAMD_SOCKET")"
  embeddings_env ""
  live_env
  echo "SEED_ADMIN_EMAIL=$(quote "$ADMIN_EMAIL")"
  echo "SEED_ADMIN_PASSWORD=$(quote "$ADMIN_PASSWORD")"
}

# Unpacks a release next to the others as <version>.new (RELEASE_DIR); activate_release
# moves it into place, so a running copy of the same version is replaced only once stopped.
unpack_release() {
  local dir=$PREFIX/releases/$VERSION.new tmp
  local archive="hubium-$VERSION-linux-$ARCH.tar.gz"
  tmp=$(mktemp -d)
  get_asset "$archive" "$tmp"
  run rm -rf "$dir"
  run install -d -m 0755 "$dir"
  run tar -xzf "$tmp/$archive" -C "$dir" --strip-components=1 --no-same-owner
  run rm -rf "$tmp"
  if [[ $DRY_RUN == no ]]; then
    [[ -x $dir/bin/hubium ]] || die "The archive has no bin/hubium."
    [[ $(cat "$dir/VERSION") == "$VERSION" ]] || warn "The archive says it is $(cat "$dir/VERSION"), not $VERSION."
  fi
  # the release stays read-only for the services; Next.js keeps its cache with the data
  run install -d -m 0750 -o hubium -g hubium "$DATA_DIR/next-cache"
  run ln -sfn "$DATA_DIR/next-cache" "$dir/web/apps/web/.next/cache"
  RELEASE_DIR=$dir
}

activate_release() {
  local final=$PREFIX/releases/$VERSION
  run rm -rf "$final"
  run mv "$RELEASE_DIR" "$final"
  RELEASE_DIR=$final
  run ln -sfn "$RELEASE_DIR" "$PREFIX/current"
}

# Runs bin/hubium of a release as the hubium user, from / (it cannot enter root's directory).
hubium_as() {
  (cd / && runuser -u hubium -- env HUBIUM_ENV_FILE="$CONFIG_DIR/hubium.env" "$1/bin/hubium" "${@:2}")
}

install_units() {
  local dir=$1 unit
  local units=(hubium-web hubium-worker)
  has_module video && units+=(hubium-worker-media)
  for unit in "${units[@]}"; do
    if [[ $DRY_RUN == yes ]]; then
      printf '  %swrite /etc/systemd/system/%s.service%s\n' "$DIM" "$unit" "$RESET"
      continue
    fi
    sed -e "s#/opt/hubium/current#$PREFIX/current#g" -e "s#/var/lib/hubium#$DATA_DIR#g" \
      "$dir/deploy/systemd/$unit.service" | write_file "/etc/systemd/system/$unit.service" 0644
    if [[ $CONFIG_DIR != /etc/hubium ]]; then
      sed -i "s#^ExecStart=#Environment=HUBIUM_ENV_FILE=$CONFIG_DIR/hubium.env\nExecStart=#" "/etc/systemd/system/$unit.service"
    fi
  done
  run systemctl daemon-reload
  SERVICES=("${units[@]}")
}

caddy_config() {
  local source=$1 marker="# Hubium LMS — written by install-hubium.sh"
  {
    echo "$marker"
    # the S3 site is for Docker installations with their own storage
    awk '/^# Presigned S3 URLs/ { exit } { print }' "$source" |
      sed -e "s#{\$APP_URL}#https://$DOMAIN#" -e "s#{\$CONTENT_HOST}#https://$CONTENT_DOMAIN#" \
        -e "s#{\$HUBIUM_WEB:web:3000}#127.0.0.1:$WEB_PORT#g"
  }
}

setup_caddy() {
  [[ $HTTPS == caddy ]] || return 0
  step "Configuring Caddy"
  local file=/etc/caddy/Caddyfile
  if [[ $DRY_RUN == yes ]]; then
    printf '  %swrite %s for %s and %s%s\n' "$DIM" "$file" "$DOMAIN" "$CONTENT_DOMAIN" "$RESET"
    return 0
  fi
  if [[ -f $file ]] && ! grep -q '^# Hubium LMS' "$file" && ! grep -q 'root \* /usr/share/caddy' "$file"; then
    caddy_config "$RELEASE_DIR/deploy/Caddyfile" | write_file /etc/caddy/hubium.caddy 0644
    warn "/etc/caddy/Caddyfile has other sites: Hubium's are in /etc/caddy/hubium.caddy. Add \"import hubium.caddy\" to it and run: systemctl reload caddy"
    return 0
  fi
  caddy_config "$RELEASE_DIR/deploy/Caddyfile" | write_file "$file" 0644
  run systemctl enable caddy
  run systemctl reload-or-restart caddy
  ok "Caddy serves https://$DOMAIN and https://$CONTENT_DOMAIN"
}

wait_healthy() {
  [[ $DRY_RUN == yes ]] && return 0
  local urls=("http://127.0.0.1:$WEB_PORT/api/health" "http://127.0.0.1:3001/healthz") url i
  has_module video && urls+=("http://127.0.0.1:3002/healthz")
  for url in "${urls[@]}"; do
    for ((i = 0; i < 90; i++)); do
      curl -fsS -o /dev/null "$url" 2>/dev/null && break
      sleep 2
    done
    ((i < 90)) || die "$url does not answer. See: journalctl -u hubium-web -u hubium-worker -n 100"
  done
  ok "web and worker answer"
}

install_native_mode() {
  [[ -f $CONFIG_DIR/hubium.env ]] && die "$CONFIG_DIR/hubium.env exists: Hubium is installed here. Upgrade with: sudo bash $0 upgrade"
  install_packages
  step "Unpacking Hubium $VERSION"
  if ! id hubium >/dev/null 2>&1; then
    run useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin hubium
  fi
  run install -d -m 0755 "$PREFIX" "$PREFIX/releases"
  run install -d -m 0750 -o hubium -g hubium "$DATA_DIR" "$DATA_DIR/files"
  run install -d -m 0750 -o root -g hubium "$CONFIG_DIR"
  unpack_release
  activate_release
  run ln -sfn "$PREFIX/current/bin/hubium" /usr/local/bin/hubium
  ok "$RELEASE_DIR, linked as $PREFIX/current and /usr/local/bin/hubium"
  create_database
  native_env | write_file "$CONFIG_DIR/hubium.env" 0640 root:hubium
  ok "settings in $CONFIG_DIR/hubium.env"

  step "Checking the database"
  if [[ $DRY_RUN == no ]]; then
    hubium_as "$RELEASE_DIR" doctor db || (($? == 2)) ||
      die "Fix the database as shown above and run the installer again."
  fi
  step "Creating the tables and the administrator"
  local off seed
  off=$(disabled_modules)
  seed=$([[ $DEMO == yes ]] && echo demo || echo minimal)
  run_shown hubium_as "$RELEASE_DIR" migrate --seed "$seed" ${off:+--disable-modules "$off"}
  forget_admin_password "$CONFIG_DIR/hubium.env"

  step "Starting the services"
  install_units "$RELEASE_DIR"
  run systemctl enable --now "${SERVICES[@]}"
  wait_healthy
  setup_caddy
}

save_install_conf() {
  {
    echo "# install-hubium.sh: how Hubium was installed, read by \"install-hubium.sh upgrade\""
    echo "MODE=$(quote "$MODE")"
    echo "VERSION=$(quote "$VERSION")"
    echo "PREFIX=$(quote "$PREFIX")"
    echo "CONFIG_DIR=$(quote "$CONFIG_DIR")"
    echo "DATA_DIR=$(quote "$DATA_DIR")"
    echo "MODULES=$(quote "$MODULES")"
    echo "DB=$(quote "$DB")"
    echo "HTTPS=$(quote "$HTTPS")"
    echo "DOMAIN=$(quote "$DOMAIN")"
    echo "CONTENT_DOMAIN=$(quote "$CONTENT_DOMAIN")"
    echo "WEB_PORT=$(quote "$WEB_PORT")"
    echo "SEED_PROFILE=$(quote "$([[ $DEMO == yes ]] && echo demo || echo minimal)")"
    echo "IMAGE=$(quote "$IMAGE")"
    echo "PGPORT=$(quote "$PGPORT")"
  } | write_file /etc/hubium/install.conf 0600
}

finish() {
  step "Done"
  [[ $DRY_RUN == yes ]] && { note "Dry run: nothing was changed."; return 0; }
  printf '\n  Hubium LMS %s is running: %shttps://%s%s\n\n' "$VERSION" "$BOLD" "$DOMAIN" "$RESET"
  note "Administrator: $ADMIN_EMAIL"
  if [[ $GENERATED_PASSWORD == yes ]]; then
    note "Password:      $ADMIN_PASSWORD   (generated; change it after signing in)"
  fi
  [[ $DEMO == yes ]] && note "Demo users:    teacher, student1 … student3, password Demo12345!"
  printf '\n'
  if [[ $HTTPS == none ]]; then
    note "Forward https://$DOMAIN and https://$CONTENT_DOMAIN to http://127.0.0.1:$WEB_PORT"
    note "with the Host header kept and X-Forwarded-Proto set."
  fi
  if [[ $MODE == docker ]]; then
    note "Settings:  $PREFIX/.env    Logs: docker compose --project-directory $PREFIX logs -f"
    note "Check:     docker compose --project-directory $PREFIX exec web hubium doctor"
    [[ -z $SMTP_URL ]] && note "Mail is caught by Mailpit at http://127.0.0.1:8025 until SMTP_URL is set in $PREFIX/.env."
  else
    note "Settings:  $CONFIG_DIR/hubium.env    Logs: journalctl -u 'hubium-*' -f"
    note "Check:     sudo -u hubium hubium doctor"
    [[ -z $SMTP_URL ]] && note "Mail is not configured: set SMTP_URL and MAIL_FROM in $CONFIG_DIR/hubium.env."
  fi
  if has_module livesession && [[ $LIVE == later ]]; then
    note "Live sessions: set BBB_URL/BBB_SECRET or JITSI_DOMAIN in the settings file."
  fi
  note "Upgrade:   sudo bash install-hubium.sh upgrade"
  note "Backups:   docs/operations.md (database and files, keep APP_SECRET)"
  note "Log of this installation: $LOG"
}

# ── upgrade ─────────────────────────────────────────────────────────────────────
upgrade() {
  [[ -f /etc/hubium/install.conf ]] || die "No installation made by this script (/etc/hubium/install.conf)."
  local requested=$VERSION
  # shellcheck disable=SC1091
  . /etc/hubium/install.conf
  local current=$VERSION
  VERSION=$requested
  [[ -n $IMAGE ]] || IMAGE=""
  # a node follows the cloud's release
  if [[ $MODE == node ]]; then
    node_update
    return 0
  fi
  resolve_version
  step "Upgrading Hubium $current → $VERSION ($MODE)"
  if [[ $current == "$VERSION" ]]; then
    note "Version $VERSION is installed already; its files are refreshed."
  fi
  yes_no BACKUP "Back up the database first?" yes
  if [[ $MODE == docker ]]; then upgrade_docker; else upgrade_native; fi
  save_install_conf
  step "Done"
  note "Hubium LMS $VERSION is running: https://$DOMAIN"
}

backup_dir() {
  [[ $DRY_RUN == yes ]] || install -d -m 0700 /var/backups/hubium
  printf '/var/backups/hubium/hubium-%s-%s.dump' "$current" "$(date -u +%Y%m%dT%H%M%SZ)"
}

# Keeps the three latest dumps made before upgrades; older ones go.
prune_backups() {
  local old
  while read -r old; do
    [[ -n $old ]] && run rm -f "$old"
  done < <(find /var/backups/hubium -maxdepth 1 -name 'hubium-*.dump' -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | tail -n +4 | cut -d' ' -f2-)
}

upgrade_docker() {
  local file
  if [[ $BACKUP == yes ]]; then
    file=$(backup_dir)
    if grep -q "^COMPOSE_PROFILES=.*db" "$PREFIX/.env"; then
      # nothing writes to the database while it is copied; the upgrade starts them again
      local app=(web worker)
      has_module video && app+=(worker-media)
      step "Stopping the application"
      run dc stop "${app[@]}"
      step "Backing up the database to $file"
      if [[ $DRY_RUN != yes ]] && ! dc exec -T db pg_dump -U hubium -Fc hubium >"$file"; then
        run dc start "${app[@]}"
        die "The backup failed; nothing was upgraded."
      fi
      ok "$(du -h "$file" 2>/dev/null | cut -f1) written"
      prune_backups
    else
      warn "The database is external: back it up with your own tools before you continue."
      confirm "Continue?" || die "Nothing was upgraded."
    fi
  fi
  step "Fetching compose.yml and Caddyfile of $VERSION"
  local tmp
  tmp=$(mktemp -d)
  get_asset compose.yml "$tmp"
  get_asset Caddyfile "$tmp"
  run cp "$PREFIX/compose.yml" "$PREFIX/compose.yml.previous"
  run cp "$tmp/compose.yml" "$tmp/Caddyfile" "$PREFIX/"
  run rm -rf "$tmp"
  [[ -f $PREFIX/node/cloud.yml ]] && node_files
  [[ $DRY_RUN == yes ]] || sed -i "s/^HUBIUM_VERSION=.*/HUBIUM_VERSION=$(quote "$VERSION")/" "$PREFIX/.env"
  if [[ $PULL == yes ]]; then
    step "Downloading the images"
    run_shown dc pull --quiet
  fi
  step "Migrating and restarting"
  run_shown dc up -d --wait --wait-timeout 600 --remove-orphans
}

upgrade_native() {
  local previous file=""
  previous=$(readlink -f "$PREFIX/current")
  step "Unpacking Hubium $VERSION"
  unpack_release
  local units=(hubium-web hubium-worker)
  has_module video && units+=(hubium-worker-media)
  if [[ $BACKUP == yes && $DB != bundled ]]; then
    warn "The database is external: back it up with your own tools before you continue."
    confirm "Continue?" || die "Nothing was upgraded."
  fi
  # stopped before the copy, so nothing writes to the database while it is taken
  step "Stopping the services"
  run systemctl stop "${units[@]}"
  if [[ $BACKUP == yes && $DB == bundled ]]; then
    file=$(backup_dir)
    step "Backing up the database to $file"
    if [[ $DRY_RUN != yes ]] &&
      ! (cd /tmp && runuser -u postgres -- pg_dump -p "${PGPORT:-5432}" -Fc hubium) >"$file"; then
      run systemctl start "${units[@]}"
      die "The backup failed; nothing was upgraded."
    fi
    ok "$(du -h "$file" 2>/dev/null | cut -f1) written"
    prune_backups
  fi
  step "Migrating the database"
  if ! hubium_as "$RELEASE_DIR" migrate --seed "${SEED_PROFILE:-minimal}"; then
    warn "Migration failed: the services of $current are started again."
    run systemctl start "${units[@]}"
    die "Restore the backup${file:+ ($file)} if the database was changed, and report the error."
  fi
  activate_release
  install_units "$RELEASE_DIR"
  run systemctl start "${SERVICES[@]}"
  wait_healthy
  if [[ $HTTPS == caddy && -f /etc/caddy/Caddyfile ]] && grep -q '^# Hubium LMS' /etc/caddy/Caddyfile; then
    caddy_config "$RELEASE_DIR/deploy/Caddyfile" | write_file /etc/caddy/Caddyfile 0644
    run systemctl reload caddy
  fi
  # keep the two releases before this one
  local old
  while read -r old; do
    [[ -n $old && $old != "$RELEASE_DIR" && $old != "$previous" ]] && run rm -rf "$old"
  done < <(find "$PREFIX/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk 'NR > 3 { print $2 }')
  ok "previous release kept in $previous"
}

# ── local nodes ─────────────────────────────────────────────────────────────────
# A node is a Docker installation in $PREFIX/node (docker/node/compose.yml): replicas of the
# cloud's database, the web server and the agent in the node role, and Caddy. It runs the
# cloud's release: hubium-node-update.timer follows the cloud after its upgrades.
NODE_DIR=""
dcn() { docker compose --project-directory "$NODE_DIR" -f "$NODE_DIR/compose.yml" --env-file "$NODE_DIR/.env" "$@"; }

# env_value FILE KEY: a value of a .env this script or `hubium node register` wrote
env_value() { sed -n "s/^$2='\{0,1\}\([^']*\)'\{0,1\}\$/\1/p" "$1" | tail -n 1; }

# The C library the replicas' image sorts text with must be the cloud's: a physical copy
# keeps the cloud's indexes, which follow its collations. Prints the Debian release of the
# PostgreSQL image with the same glibc.
node_pg_image() {
  local major=${1:-18} collation=$2 debian glibc
  if [[ $collation != c:* || -z ${collation#c:} || $DRY_RUN == yes ]]; then
    printf 'bookworm'
    return 0
  fi
  for debian in bookworm trixie; do
    [[ $PULL == yes ]] && docker pull -q "pgvector/pgvector:0.8.7-pg$major-$debian" >>"$LOG" 2>&1
    glibc=$(docker run --rm --entrypoint ldd "pgvector/pgvector:0.8.7-pg$major-$debian" --version 2>/dev/null |
      awk 'NR == 1 { print $NF }')
    if [[ $glibc == "${collation#c:}" ]]; then
      printf '%s' "$debian"
      return 0
    fi
  done
  die "The cloud's database sorts text with glibc ${collation#c:}; no PostgreSQL image for nodes has it (bookworm 2.36, trixie 2.41). Install the cloud with Docker, or see docs/operations.md."
}

# The node's files of a release (compose.yml, Caddyfile, replica.sh and the cloud's) in
# $PREFIX/node.
node_files() {
  local tmp
  tmp=$(mktemp -d)
  get_asset node.tar.gz "$tmp"
  run tar -xzf "$tmp/node.tar.gz" -C "$PREFIX" --no-same-owner
  run rm -rf "$tmp"
}

install_node() {
  [[ -n $HUB ]] || die "--hub is needed with --node: the cloud's address, e.g. https://lms.example.org"
  [[ -n $NODE_CODE ]] || die "--code is needed with --node: Administration → Nodes in the cloud gives it."
  [[ $HUB == https://* || $HUB == http://* ]] || HUB="https://$HUB"
  NODE_TLS=${NODE_TLS:-cloud}
  case $NODE_TLS in
    cloud) ;;
    acme | internal)
      [[ -n $DOMAIN && -n $CONTENT_DOMAIN ]] ||
        die "--node-tls $NODE_TLS gives the node names of its own: --domain and --content-domain."
      ;;
    *) die "--node-tls: cloud, acme or internal." ;;
  esac
  # the node's processes trust this authority besides the public ones (the hubium launcher
  # gives it to Node.js)
  local hub_ca=""
  if [[ -n $HUB_CA ]]; then
    [[ -r $HUB_CA ]] || die "--hub-ca $HUB_CA: no such file."
    if have openssl; then
      openssl x509 -noout -in "$HUB_CA" 2>/dev/null || die "--hub-ca $HUB_CA: not a PEM certificate."
    fi
    hub_ca=$(base64 -w0 <"$HUB_CA")
  fi
  MODE=node
  resolve_version
  check_docker
  NODE_DIR=$PREFIX/node
  [[ -f $NODE_DIR/.env ]] && die "$NODE_DIR/.env exists: a node is installed here."
  local image=${IMAGE:-ghcr.io/sharapov-outsource/hubium-lms}:$VERSION reg file
  step "Registering this node with $HUB"
  [[ $PULL == yes ]] && run docker pull -q "$image"
  if [[ $DRY_RUN == yes ]]; then
    reg="HUBIUM_VERSION='$VERSION'"
  else
    reg=$(docker run --rm ${hub_ca:+-e NODE_HUB_CA="$hub_ca"} "$image" node register \
      --hub "$HUB" --code "$NODE_CODE" ${HUB_ADDRESS:+--address "$HUB_ADDRESS"}) ||
      die "The cloud did not register this node (see above)."
  fi
  ok "registered"
  file=$(mktemp)
  printf '%s\n' "$reg" >"$file"
  local cloud_version major collation debian
  cloud_version=$(env_value "$file" HUBIUM_VERSION)
  major=$(env_value "$file" NODE_PG_MAJOR)
  collation=$(env_value "$file" NODE_DB_COLLATION)
  step "Checking that this server can copy the cloud's database"
  debian=$(node_pg_image "$major" "$collation")
  ok "PostgreSQL ${major:-18} ($debian)"
  # the node runs the cloud's release, with its files
  VERSION=${cloud_version:-$VERSION}
  run install -d -m 0750 "$PREFIX"
  node_files
  {
    echo "# Hubium LMS local node — written by install-hubium.sh. After a change:"
    echo "# docker compose --project-directory $NODE_DIR up -d"
    cat "$file"
    echo "NODE_PG_DEBIAN=$(quote "$debian")"
    echo "NODE_TLS=$(quote "$NODE_TLS")"
    if [[ -n $IMAGE ]]; then echo "HUBIUM_IMAGE=$(quote "$IMAGE")"; fi
    if [[ -n $hub_ca ]]; then echo "NODE_HUB_CA=$(quote "$hub_ca")"; fi
    if [[ $NODE_TLS != cloud ]]; then
      echo "APP_URL=$(quote "https://$DOMAIN")"
      echo "CONTENT_HOST=$(quote "https://$CONTENT_DOMAIN")"
    fi
    if [[ -n $SMTP_URL ]]; then echo "SMTP_URL=$(quote "$SMTP_URL")"; fi
    if [[ -n $MAIL_FROM ]]; then echo "MAIL_FROM=$(quote "$MAIL_FROM")"; fi
  } | write_file "$NODE_DIR/.env" 0600
  rm -f "$file"
  if [[ $PULL == yes ]]; then
    step "Downloading the images"
    run_shown dcn pull --quiet
  fi
  step "Starting the node: it copies the cloud's database first"
  run_shown dcn up -d
  install_node_update
  save_install_conf
  step "Done"
  [[ $DRY_RUN == yes ]] && { note "Dry run: nothing was changed."; return 0; }
  note "The node copies the cloud's database and files, then serves this network."
  note "State:     docker compose --project-directory $NODE_DIR exec agent hubium node status"
  note "Logs:      docker compose --project-directory $NODE_DIR logs -f"
  if [[ $NODE_TLS == cloud ]]; then
    note "DNS:       in this network, point the cloud's main and content hosts at this server."
  fi
  note "Updates:   the node follows the cloud's release (hubium-node-update.timer)."
}

# Follows the cloud's release: hubium-node-update.timer runs node-update every ten minutes.
install_node_update() {
  if [[ ! -d /run/systemd/system ]]; then
    warn "No systemd: run \"install-hubium.sh node-update\" after the cloud's upgrades."
    return 0
  fi
  run install -m 0755 "$0" "$PREFIX/install-hubium.sh"
  printf '%s\n' "[Unit]" "Description=Hubium LMS local node: follow the cloud's release" \
    "After=docker.service" "" "[Service]" "Type=oneshot" \
    "ExecStart=/bin/bash $PREFIX/install-hubium.sh node-update --yes" |
    write_file /etc/systemd/system/hubium-node-update.service 0644
  printf '%s\n' "[Unit]" "Description=Hubium LMS local node: follow the cloud's release" "" \
    "[Timer]" "OnBootSec=5min" "OnUnitActiveSec=10min" "" "[Install]" "WantedBy=timers.target" |
    write_file /etc/systemd/system/hubium-node-update.timer 0644
  run systemctl daemon-reload
  run systemctl enable --now hubium-node-update.timer
}

node_update() {
  [[ -f /etc/hubium/install.conf ]] || die "No installation made by this script (/etc/hubium/install.conf)."
  # shellcheck disable=SC1091
  . /etc/hubium/install.conf
  [[ $MODE == node ]] || die "node-update is for local nodes."
  NODE_DIR=$PREFIX/node
  local state cloud current
  state=$(dcn exec -T agent hubium node status --json 2>/dev/null) || die "The node's agent does not answer."
  cloud=$(sed -n 's/.*"cloudRelease":"\([^"+]*\).*/\1/p' <<<"$state")
  current=$(env_value "$NODE_DIR/.env" HUBIUM_VERSION)
  [[ -n $cloud && $cloud != "$current" ]] || return 0
  step "The cloud runs $cloud: upgrading the node from $current"
  VERSION=$cloud
  node_files
  [[ $DRY_RUN == yes ]] || sed -i "s/^HUBIUM_VERSION=.*/HUBIUM_VERSION=$(quote "$VERSION")/" "$NODE_DIR/.env"
  if [[ $PULL == yes ]]; then run_shown dcn pull --quiet; fi
  run_shown dcn up -d --remove-orphans
  save_install_conf
}

# In the cloud: the bundled database takes the replication of local nodes over TLS.
enable_nodes() {
  [[ -f /etc/hubium/install.conf ]] || die "No installation made by this script (/etc/hubium/install.conf)."
  local requested=$VERSION
  # shellcheck disable=SC1091
  . /etc/hubium/install.conf
  [[ -n $requested ]] && VERSION=$requested
  [[ $MODE == docker ]] || die "enable-nodes sets up a Docker installation; for a native one see docs/operations.md (Local nodes)."
  [[ $DB == bundled ]] || die "The database is external: let the nodes replicate it as docs/operations.md (Local nodes) shows."
  have openssl || die "openssl is missing (apt-get install openssl)."
  local host=${REPLICATION_HOST:-$DOMAIN} port=${REPLICATION_PORT:-5432}
  step "Fetching the files for local nodes"
  node_files
  local tls=$PREFIX/node/tls
  if [[ ! -f $tls/server.crt ]]; then
    step "A certificate for the database's TLS"
    run install -d -m 0755 "$tls"
    run openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -subj "/CN=$host" \
      -keyout "$tls/server.key" -out "$tls/server.crt"
    run chmod 0600 "$tls/server.key"
    run chmod 0644 "$tls/server.crt"
  fi
  if [[ $DRY_RUN == no ]]; then
    sed -i '/^NODE_REPLICATION_\(HOST\|PORT\)=/d' "$PREFIX/.env"
    {
      echo "NODE_REPLICATION_HOST=$(quote "$host")"
      echo "NODE_REPLICATION_PORT=$(quote "$port")"
    } >>"$PREFIX/.env"
  fi
  step "Restarting with replication on"
  run_shown dc up -d --wait --wait-timeout 600
  save_install_conf
  step "Done"
  note "Nodes replicate over TLS on port $port of $host: open it to the nodes' addresses only."
  note "Add a node in Administration → Nodes; its code installs it on the node's server:"
  note "  sudo bash install-hubium.sh --node --hub https://$DOMAIN --code <code>"
}

# ── main ────────────────────────────────────────────────────────────────────────
main() {
  printf '%sHubium LMS installer%s\n' "$BOLD" "$RESET"
  preflight
  case $ACTION in
    upgrade) upgrade; return 0 ;;
    enable-nodes) enable_nodes; return 0 ;;
    node-update) node_update; return 0 ;;
  esac
  if [[ $NODE == yes ]]; then
    install_node
    return 0
  fi
  ask_everything
  resolve_version
  if [[ $MODE == docker ]]; then check_docker; else check_native; fi
  check_site
  summary
  if [[ $MODE == docker ]]; then install_docker_mode; else install_native_mode; fi
  save_install_conf
  finish
}

main
