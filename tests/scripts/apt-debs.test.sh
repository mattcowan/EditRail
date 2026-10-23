#!/usr/bin/env bash
# Tests scripts/apt-debs.sh with stand-in apt-get, apt-cache, dpkg-deb and
# sudo, so it runs on any machine with bash, including Git Bash. The
# "Version check + package" job in ci.yml runs it.
#
#   bash tests/scripts/apt-debs.test.sh
#
# A fake .deb is a text file: "Package: x" and "Version: y" lines.
set -uo pipefail

script=$(cd "$(dirname "$0")/../.." && pwd)/scripts/apt-debs.sh
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir -p "$t/bin" "$t/archives" "$t/debs" "$t/home"

# HOME points at a temporary folder, so a broken guard in `collect` can
# only delete that folder.
export HOME="$t/home"
export APT_DEBS_ARCHIVES="$t/archives"

cat >"$t/bin/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
cat >"$t/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo "apt-get $*"
EOF
cat >"$t/bin/dpkg-deb" <<'EOF'
#!/usr/bin/env bash
grep -q '^Package:' "$2" || { echo "dpkg-deb: not a deb" >&2; exit 2; }
sed -n "s/^$3: //p" "$2"
EOF
# The index has one line per package: "pkg=ver sha256". After the hash,
# the stand-in writes 500 kB with the shell's own echo. A grep that stops
# reading early makes this process die of SIGPIPE, as apt-cache would.
cat >"$t/bin/apt-cache" <<EOF
#!/usr/bin/env bash
found=0
while read -r key sum; do
	if [ "\$key" = "\$2" ]; then
		echo "Package: \${2%%=*}"
		echo "SHA256: \$sum"
		pad=\$(printf '%0100d' 0)
		for i in \$(seq 5000); do echo "\$pad"; done
		found=1
	fi
done <"$t/index"
[ \$found = 1 ] || { echo "E: Version not found" >&2; exit 100; }
EOF
chmod +x "$t/bin/"*
export PATH="$t/bin:$PATH"

printf 'Package: good\nVersion: 1:2.0\n' >"$t/debs/good_1%3a2.0_amd64.deb"
printf 'Package: tampered\nVersion: 1.0\n' >"$t/debs/tampered_1.0_amd64.deb"
printf 'Package: unknown\nVersion: 1.0\n' >"$t/debs/unknown_1.0_amd64.deb"
printf 'garbage' >"$t/debs/corrupt_1.0_amd64.deb"
good_sum=$(sha256sum "$t/debs/good_1%3a2.0_amd64.deb" | cut -d' ' -f1)
{
	echo "good=1:2.0 $good_sum"
	echo "tampered=1.0 0000000000000000000000000000000000000000000000000000000000000000"
} >"$t/index"

fail=0
check() {
	if eval "$2"; then
		echo "ok   - $1"
	else
		echo "FAIL - $1"
		fail=1
	fi
}

out=$(bash "$script" place "$t/debs" 2>&1)
rc=$?
check "place exits 0" '[ $rc = 0 ]'
check "a file whose hash is in the index is placed" '[ -e "$t/archives/good_1%3a2.0_amd64.deb" ]'
check "a file with a different hash is skipped" '[ ! -e "$t/archives/tampered_1.0_amd64.deb" ]'
check "a package not in the index is skipped" '[ ! -e "$t/archives/unknown_1.0_amd64.deb" ]'
check "a file that is not a .deb is skipped" '[ ! -e "$t/archives/corrupt_1.0_amd64.deb" ]'
check "place reports 1 placed and 3 skipped" 'grep -q "Gave apt 1 cached packages; skipped 3." <<<"$out"'

out=$(bash "$script" place "$t/missing" 2>&1)
rc=$?
check "place with no cache folder exits 0" '[ $rc = 0 ] && grep -q "Gave apt 0" <<<"$out"'

printf 'Package: new\nVersion: 3\n' >"$t/archives/new_3_amd64.deb"
mkdir -p "$t/col"
touch "$t/col/old_1_amd64.deb"
h1=$(bash "$script" collect "$t/col" 2>/dev/null)
rc=$?
check "collect exits 0" '[ $rc = 0 ]'
check "collect prints a 16-character hash" '[[ $h1 =~ ^[0-9a-f]{16}$ ]]'
check "collect copies every archive" '[ "$(ls "$t/col" | wc -l)" = 2 ]'
check "collect removes old files from the folder" '[ ! -e "$t/col/old_1_amd64.deb" ]'
h2=$(bash "$script" collect "$t/col" 2>/dev/null)
check "the same files give the same hash" '[ "$h1" = "$h2" ]'
printf 'Package: new\nVersion: 3\nrepaired\n' >"$t/archives/new_3_amd64.deb"
h3=$(bash "$script" collect "$t/col" 2>/dev/null)
check "a new file with the same name gives a new hash" '[ -n "$h3" ] && [ "$h1" != "$h3" ]'
rm "$t/archives/new_3_amd64.deb"
h4=$(bash "$script" collect "$t/col" 2>/dev/null)
check "one file less gives a new hash" '[ -n "$h4" ] && [ "$h4" != "$h3" ] && [ "$h4" != "$h1" ]'

rm "$t/archives/"*.deb
h5=$(bash "$script" collect "$t/col" 2>"$t/err")
rc=$?
check "an empty archive folder gives exit 0 and no hash" '[ $rc = 0 ] && [ -z "$h5" ]'
check "an empty archive folder gives a warning" 'grep -q "::warning::" "$t/err"'

touch "$HOME/keep"
bash "$script" collect "$HOME" >/dev/null 2>&1
rc=$?
check "collect refuses \$HOME" '[ $rc = 2 ] && [ -e "$HOME/keep" ]'
bash "$script" collect "$HOME/" >/dev/null 2>&1
rc=$?
check "collect refuses \$HOME/" '[ $rc = 2 ] && [ -e "$HOME/keep" ]'

exit $fail
