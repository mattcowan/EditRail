#!/usr/bin/env bash
# Keeps the Ubuntu packages that `playwright install --with-deps` downloads
# in an Actions cache, so a slow Ubuntu mirror does not hold up the browser
# jobs (#81). Used by .github/workflows/ci.yml and apt-cache.yml.
#
#   bash scripts/apt-debs.sh place DIR
#     Copy each .deb file in DIR that the package index lists into apt's
#     archive cache, where `apt-get install` uses it instead of
#     downloading it.
#   bash scripts/apt-debs.sh collect DIR
#     Replace the contents of DIR with the .deb files in apt's archive
#     cache, and print a hash of their names and contents for the cache
#     key. Prints nothing when there are none. DIR is deleted first, so
#     it refuses / and $HOME.
#
# apt reuses a file in /var/cache/apt/archives when its SIZE matches the
# index. It does not check the hash (the pkgAcqArchive constructor in
# apt-pkg/acquire-item.cc). So `place` checks each file's SHA256 against
# the signed index first, and skips a file that does not match: an old
# version, a package from another Ubuntu release, or a damaged cache.
#
# tests/scripts/apt-debs.test.sh sets APT_DEBS_ARCHIVES to a temporary
# folder. Nothing else sets it.
set -euo pipefail

archives=${APT_DEBS_ARCHIVES:-/var/cache/apt/archives}

place() {
	local dir=$1 deb pkg ver sum placed=0 skipped=0
	mkdir -p "$dir"
	sudo apt-get update -q
	for deb in "$dir"/*.deb; do
		[ -e "$deb" ] || continue
		if pkg=$(dpkg-deb -f "$deb" Package 2>/dev/null) &&
			ver=$(dpkg-deb -f "$deb" Version 2>/dev/null) &&
			sum=$(sha256sum "$deb" | cut -d' ' -f1) &&
			# Not grep -q: it can stop reading early, and with pipefail
			# the SIGPIPE to apt-cache would turn a match into a skip.
			apt-cache show "$pkg=$ver" 2>/dev/null | grep -x "SHA256: $sum" >/dev/null; then
			sudo cp "$deb" "$archives/"
			placed=$((placed + 1))
		else
			echo "Skipped $(basename "$deb"): its hash is not in the package index."
			skipped=$((skipped + 1))
		fi
	done
	echo "Gave apt $placed cached packages; skipped $skipped."
}

collect() {
	local dir=$1 count
	case "${dir%/}" in
		"" | "$HOME")
			echo "Refusing to replace $dir." >&2
			exit 2
			;;
	esac
	rm -rf "$dir"
	mkdir -p "$dir"
	count=$(find "$archives" -maxdepth 1 -name '*.deb' | wc -l)
	if [ "$count" -eq 0 ]; then
		echo "::warning::apt kept no .deb files in $archives; nothing to cache." >&2
		return
	fi
	cp "$archives"/*.deb "$dir/"
	echo "Collected $count packages." >&2
	# Contents too, not only names: when `place` skips a damaged file, apt
	# downloads a good one with the same name, and the key must change so
	# the good one is saved.
	# LC_ALL=C before the glob, so the file order does not depend on the
	# locale.
	(cd "$dir" && export LC_ALL=C && sha256sum -- *.deb) | sha256sum | cut -c1-16
}

case "${1:-}" in
	place | collect) "$1" "${2:?Usage: $0 place|collect DIR}" ;;
	*)
		echo "Usage: $0 place|collect DIR" >&2
		exit 2
		;;
esac
