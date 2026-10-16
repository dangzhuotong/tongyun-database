#!/usr/bin/env bash
# 把 Coding 套装 7 个 skill 以「真实文件」复制进本项目 .agents/skills/。两个版本可选：
#   lite（默认）：开源 MIT 精简版 tong-project / tong-product / …，公开仓，不需要任何私有权限；
#   pro         ：商业完整版 tong-*-pro，来自私有仓 tongyun-skills-plus（需要访问权限）。
# - 项目级：随项目一起提交；只写 <项目>/.agents/skills，绝不写 ~/.cursor ~/.codex ~/.workbuddy 等全局目录。
# - 重复运行 = 原地刷新；tong-* 目录由本脚本管理，本地改动会被覆盖。
#   项目自己的 skill 请用 <项目名>-xxx 命名放在同一目录，本脚本不会碰。
# - 切换版本时会删掉另一版本的 7 个目录，并把 AGENTS.md 里点名的 skill 链接改成当前版本。
# 用法：bash scripts/sync-skills.sh [--edition lite|pro] [项目根目录，默认=本脚本上一级]
# 版本选择顺序：--edition → 环境变量 TONGYUN_SKILLS_EDITION → 上次同步记在 SOURCES.md 的版本 → lite
# 环境变量（lite）：
#   TONGYUN_SKILLS_LITE        已有 lite 仓本地路径（设置了就只用它）
#   TONGYUN_SKILLS_LITE_CACHE  缓存路径，默认 ~/.cache/tongyun-skills-lite
#   TONGYUN_SKILLS_LITE_GIT    clone 地址，默认 https://github.com/dangzhuotong/tongyun-skills-lite.git（仓名待定，占位）
# 环境变量（pro）：
#   TONGYUN_SKILLS_PLUS        已有 skills-plus 本地路径（设置了就只用它）
#   TONGYUN_SKILLS_CACHE       缓存路径，默认 ~/.cache/tongyun-skills-plus
#   TONGYUN_SKILLS_PLUS_GIT    clone 地址，默认 git@github.com:dangzhuotong/tongyun-skills-plus.git
# 退出码：0 成功；1 拿不到来源仓或源缺 skill（项目文件未改动）；2 参数/目标错误。
set -euo pipefail

BASES="project product ui-design api test code-review deploy"

usage() { echo "用法：bash scripts/sync-skills.sh [--edition lite|pro] [项目根目录]" >&2; }

EDITION_ARG=""
PROJECT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --edition) [[ $# -ge 2 ]] || { usage; exit 2; }; EDITION_ARG="$2"; shift 2 ;;
    --edition=*) EDITION_ARG="${1#--edition=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "sync-skills: 未知参数 $1" >&2; usage; exit 2 ;;
    *) [[ -z "$PROJECT" ]] || { usage; exit 2; }; PROJECT="$1"; shift ;;
  esac
done

PROJECT="${PROJECT:-$(cd "$(dirname "$0")/.." && pwd)}"
[[ -d "$PROJECT" ]] || { echo "sync-skills: 项目目录不存在：$PROJECT" >&2; exit 2; }
PROJECT="$(cd "$PROJECT" && pwd)"

# 公开脚手架仓本身不能装 skill 正文（两个版本都不放进脚手架）
if [[ -f "$PROJECT/scripts/init-project.sh" && -d "$PROJECT/templates" ]]; then
  echo "sync-skills: $PROJECT 看起来是 tongyun-scaffold 本身（公开仓），拒绝写入 skill 正文。请对 init 出来的项目运行。" >&2
  exit 2
fi

DEST="$PROJECT/.agents/skills"

# 上次同步的版本
PREV_EDITION=""
if [[ -f "$DEST/SOURCES.md" ]]; then
  PREV_EDITION="$(sed -n -E 's/^- edition: (lite|pro)$/\1/p' "$DEST/SOURCES.md" | head -n 1)"
  if [[ -z "$PREV_EDITION" ]] && grep -q 'tongyun-skills-plus' "$DEST/SOURCES.md"; then
    PREV_EDITION="pro"   # 加版本开关之前同步的项目，都是 pro
  fi
fi

EDITION="${EDITION_ARG:-${TONGYUN_SKILLS_EDITION:-${PREV_EDITION:-lite}}}"
case "$EDITION" in
  lite|pro) ;;
  *) echo "sync-skills: 版本只能是 lite 或 pro，收到：$EDITION" >&2; exit 2 ;;
esac

warn() { echo "sync-skills: $*" >&2; }

skill_name() { # $1=base $2=edition
  if [[ "$2" == "pro" ]]; then echo "tong-$1-pro"; else echo "tong-$1"; fi
}

SKILLS=""
OTHER_SKILLS=""
OTHER="pro"; [[ "$EDITION" == "pro" ]] && OTHER="lite"
for b in $BASES; do
  SKILLS="$SKILLS $(skill_name "$b" "$EDITION")"
  OTHER_SKILLS="$OTHER_SKILLS $(skill_name "$b" "$OTHER")"
done

if [[ "$EDITION" == "pro" ]]; then
  LOCAL_SRC="${TONGYUN_SKILLS_PLUS:-}"
  LOCAL_VAR="TONGYUN_SKILLS_PLUS"
  REPO_URL="${TONGYUN_SKILLS_PLUS_GIT:-git@github.com:dangzhuotong/tongyun-skills-plus.git}"
  CACHE="${TONGYUN_SKILLS_CACHE:-$HOME/.cache/tongyun-skills-plus}"
  LABEL="tongyun-skills-plus（私有仓，需本机 SSH 能访问 GitHub）"
else
  LOCAL_SRC="${TONGYUN_SKILLS_LITE:-}"
  LOCAL_VAR="TONGYUN_SKILLS_LITE"
  # TODO: 开源仓建好后把占位地址换成正式仓名
  REPO_URL="${TONGYUN_SKILLS_LITE_GIT:-https://github.com/dangzhuotong/tongyun-skills-lite.git}"
  CACHE="${TONGYUN_SKILLS_LITE_CACHE:-$HOME/.cache/tongyun-skills-lite}"
  LABEL="开源 lite 仓（公开，无需权限）"
fi

SRC=""
if [[ -n "$LOCAL_SRC" ]]; then
  if [[ -d "$LOCAL_SRC/skills" ]]; then
    SRC="$LOCAL_SRC"
  else
    warn "${LOCAL_VAR}=$LOCAL_SRC 下没有 skills/ 目录"
    exit 1
  fi
elif [[ -d "$CACHE/skills" ]]; then
  SRC="$CACHE"
  if [[ -d "$CACHE/.git" ]]; then
    git -C "$CACHE" pull --ff-only --quiet || warn "缓存 git pull 失败，沿用本地缓存版本（${CACHE}）"
  fi
else
  if [[ -e "$CACHE" ]]; then
    warn "缓存路径 $CACHE 已存在但不是 skill 仓 checkout，请删掉后重试"
    exit 1
  fi
  mkdir -p "$(dirname "$CACHE")"
  echo "sync-skills: clone $LABEL …"
  if ! git clone --quiet "$REPO_URL" "$CACHE"; then
    rm -rf "$CACHE"
    warn "clone 失败：$REPO_URL"
    exit 1
  fi
  SRC="$CACHE"
fi

for name in $SKILLS; do
  if [[ ! -f "$SRC/skills/$name/SKILL.md" ]]; then
    warn "源里缺 $SRC/skills/$name/SKILL.md（版本 $EDITION）"
    exit 1
  fi
done

# 来源信息（去掉 URL 里的账号/令牌）
SRC_URL="(非 git checkout)"
HAVE_GIT=0
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  HAVE_GIT=1
  SRC_URL="$(git -C "$SRC" remote get-url origin 2>/dev/null || echo '(无 origin)')"
  SRC_URL="$(printf '%s' "$SRC_URL" | sed -E 's#(https?://)[^@/]*@#\1#')"
fi

mkdir -p "$DEST"
STAGE="$(mktemp -d "$DEST/.sync.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

ROWS=""
for name in $SKILLS; do
  # -L：源里若有软链，复制成真实文件，保证 clone 到别的机器也能用
  cp -RL "$SRC/skills/$name" "$STAGE/$name"
  # 排除测试与临时文件
  find "$STAGE/$name" \( -name tests -o -name test -o -name __pycache__ -o -name .pytest_cache -o -name tmp -o -name node_modules \) -type d -prune -exec rm -rf {} +
  find "$STAGE/$name" -type f \( -name '*.pyc' -o -name '*.tmp' -o -name '*.log' -o -name '*.swp' -o -name '.DS_Store' -o -name 'Thumbs.db' -o -name '*~' \) -delete
  sha="unknown"
  if [[ "$HAVE_GIT" == 1 ]]; then
    sha="$(git -C "$SRC" log -1 --format=%H -- "skills/$name" 2>/dev/null || true)"
    [[ -n "$sha" ]] || sha="unknown"
    if [[ -n "$(git -C "$SRC" status --porcelain -- "skills/$name" 2>/dev/null)" ]]; then
      sha="$sha+dirty"
    fi
  fi
  ROWS="$ROWS| \`$name\` | \`skills/$name\` | \`$sha\` |
"
done

HEAD_SHA="unknown"
[[ "$HAVE_GIT" == 1 ]] && HEAD_SHA="$(git -C "$SRC" rev-parse HEAD)"

# 原地替换；切换版本时删掉另一版本的同名工种
for name in $SKILLS; do
  rm -rf "${DEST:?}/$name"
  mv "$STAGE/$name" "$DEST/$name"
done
REMOVED=""
for name in $OTHER_SKILLS; do
  if [[ -d "$DEST/$name" ]]; then
    rm -rf "${DEST:?}/$name"
    REMOVED="$REMOVED $name"
  fi
done

if [[ "$EDITION" == "pro" ]]; then
  NOTE="注意：pro 版来自私有、商业许可的 tongyun-skills-plus。项目若公开，这里的 tong-*-pro 正文也会跟着公开；公开前先切回 lite（\`bash scripts/sync-skills.sh --edition lite\`）。"
else
  NOTE="lite 版是 MIT 开源精简版，项目公开也没问题。需要完整版：\`bash scripts/sync-skills.sh --edition pro\`（要有 tongyun-skills-plus 访问权限）。"
fi

cat > "$DEST/SOURCES.md" <<MD
# 项目 skill 来源

本文件由 \`scripts/sync-skills.sh\` 生成，不要手改。

- edition: $EDITION
- 来源仓：$SRC_URL
- 来源 HEAD：\`$HEAD_SHA\`
- 同步时间：$(date -u +%Y-%m-%dT%H:%M:%SZ)

| skill | 源路径 | 最后改动该目录的 commit |
| --- | --- | --- |
${ROWS}
\`tong-*\` 目录由同步脚本管理，重跑会覆盖本地改动；项目自己的 skill 用 \`<项目名>-xxx\` 命名放在本目录，不受影响。

$NOTE
MD

# AGENTS.md 里点名的 skill 链接跟着版本走（只改这 7 个工种的名字，别的内容不动）
AGENTS_FILE="$PROJECT/AGENTS.md"
if [[ -f "$AGENTS_FILE" && ! -L "$AGENTS_FILE" ]]; then
  sed_script="$(mktemp)"
  tmp_agents="$(mktemp)"
  for b in $BASES; do
    # 只匹配链接里的「tong-xxx]」和「tong-xxx/」，不碰正文里别的写法
    if [[ "$EDITION" == "pro" ]]; then
      printf 's#tong-%s\\([]/]\\)#tong-%s-pro\\1#g\n' "$b" "$b" >> "$sed_script"
    else
      printf 's#tong-%s-pro\\([]/]\\)#tong-%s\\1#g\n' "$b" "$b" >> "$sed_script"
    fi
  done
  sed -f "$sed_script" "$AGENTS_FILE" > "$tmp_agents"
  if ! cmp -s "$tmp_agents" "$AGENTS_FILE"; then
    cat "$tmp_agents" > "$AGENTS_FILE"
    echo "sync-skills: 已把 AGENTS.md 里的 skill 链接改成 $EDITION 版"
  fi
  rm -f "$sed_script"
  rm -f "$tmp_agents"
fi

# 保证各 Agent 入口指向同一份（已存在则不动）
for link in .claude/skills .cursor/skills; do
  p="$PROJECT/$link"
  if [[ -L "$p" || ! -e "$p" ]]; then
    mkdir -p "$(dirname "$p")"
    ln -sfn ../.agents/skills "$p"
  else
    warn "$link 是真实目录，未改成软链；建议手动删掉后重跑（旧版 install-coding-skills 留下的）"
  fi
done

if [[ -n "$REMOVED" ]]; then
  echo "sync-skills: 已从 $OTHER 版切到 $EDITION 版，移除了:$REMOVED"
fi
echo "sync-skills: 已同步 7 个 Coding skill（$EDITION 版）到 ${DEST}（源 $SRC_URL @ ${HEAD_SHA:0:7}）"
