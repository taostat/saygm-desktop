#!/usr/bin/env python3
"""Prepare a pinned upstream merge in a separate worktree without publishing it."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


def git(root, *args, check=True):
    return subprocess.run(
        ["git", "-C", str(root), *args], text=True, capture_output=True, check=check
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("revision", help="Full upstream commit SHA, fetched before running")
    parser.add_argument("worktree", type=Path, help="New directory for the update branch")
    parser.add_argument("--branch", required=True, help="New local update branch")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        parser.error("revision must be a full 40-character commit SHA")
    if git(root, "status", "--porcelain").stdout.strip():
        parser.error("source worktree must be clean; commit scoped changes first")
    source_revision = git(root, "rev-parse", "HEAD").stdout.strip()
    manifest = json.loads(git(root, "show", source_revision + ":maintenance/upstream.json").stdout)
    remote_url = git(root, "remote", "get-url", "upstream", check=False)
    if remote_url.returncode or remote_url.stdout.strip() != manifest["repository"]:
        parser.error("upstream remote must match maintenance/upstream.json; see maintenance/UPSTREAM.md")
    if args.worktree.exists():
        parser.error("worktree destination already exists")
    if root == args.worktree.resolve() or root in args.worktree.resolve().parents:
        parser.error("worktree destination must be outside the source checkout")
    base = manifest["integrated_revision"]
    for ancestor, descendant in ((base, source_revision), (base, args.revision)):
        if git(root, "merge-base", "--is-ancestor", ancestor, descendant, check=False).returncode:
            parser.error(f"{ancestor} must be an ancestor of {descendant}; check upstream provenance")
    upstream_ref = "refs/remotes/upstream/" + manifest["branch"]
    if git(root, "merge-base", "--is-ancestor", args.revision, upstream_ref, check=False).returncode:
        parser.error("revision is not reachable from fetched upstream/main")
    if git(root, "merge-base", "--is-ancestor", args.revision, source_revision, check=False).returncode == 0:
        parser.error("revision is already in this branch's ancestry")
    git(root, "check-ref-format", "--branch", args.branch)
    git(root, "worktree", "add", "-b", args.branch, str(args.worktree.resolve()), source_revision)
    result = git(args.worktree, "merge", "--no-commit", "--no-ff", args.revision, check=False)
    conflicts = git(args.worktree, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
    report = {
        "source_revision": source_revision,
        "previous_upstream_revision": base,
        "candidate_upstream_revision": args.revision,
        "worktree": str(args.worktree.resolve()),
        "branch": args.branch,
        "merge_exit_code": result.returncode,
        "conflicts": conflicts,
        "upstream_changed_files": git(root, "diff", "--name-only", base, args.revision).stdout.splitlines(),
        "merge_output": result.stdout + result.stderr,
    }
    print(json.dumps(report, indent=2))
    print("Review all changes, including workflows and product policy. Resolve conflicts, update "
          "maintenance/upstream.json only after integration, and complete the documented checks "
          "before committing or publishing.", file=sys.stderr)
    return result.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        print(error.stderr, file=sys.stderr)
        sys.exit(error.returncode)
