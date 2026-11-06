#!/usr/bin/env bash
set -euo pipefail

branch="${1:?Usage: push_data_branch.sh <branch> [remote]}"
remote="${2:-origin}"
token="${GH_TOKEN:-}"
if [[ -z "$token" ]]; then
  echo 'GH_TOKEN is required to publish the data branch.' >&2
  exit 1
fi

token_auth="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
git_with_auth() {
  git -c "http.extraheader=AUTHORIZATION: basic ${token_auth}" "$@"
}

# Publishers now build concurrently and touch separate paths on the same data
# branch. Rebase after a rejected push so another publisher's completed update
# is retained instead of dropping this publisher's changes.
for attempt in 1 2 3 4 5; do
  if git_with_auth push --quiet "$remote" "HEAD:${branch}"; then
    exit 0
  fi
  if [[ "$attempt" -eq 5 ]]; then
    break
  fi

  echo "Data branch advanced during publish; rebasing and retrying ($attempt/5)." >&2
  git_with_auth fetch --quiet "$remote" "$branch"
  if ! git rebase --quiet FETCH_HEAD; then
    git rebase --abort >/dev/null 2>&1 || true
    echo 'Unable to rebase publisher changes onto the current data branch.' >&2
    exit 1
  fi
done

echo "Could not publish to ${branch} after five attempts." >&2
exit 1
