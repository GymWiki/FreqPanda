import { NextRequest, NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const REPO = "GymWiki/Trading-platform";
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

// One asset-name check per platform, deliberately excluding the .sig
// files release-desktop-app.yml uploads alongside every installer (see
// createUpdaterArtifacts in src-tauri/tauri.conf.json) — those are for the
// in-app updater to verify with, never something a person should download
// by hand.
const PLATFORM_MATCHERS: Record<string, (assetName: string) => boolean> = {
  windows: (name) => name.endsWith(".exe") && !name.endsWith(".sig"),
  mac: (name) => name.endsWith(".dmg") && !name.endsWith(".sig"),
};

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

// Landing-page download buttons hit this instead of a hardcoded file URL,
// so a click always starts a real download immediately rather than
// dropping the visitor on the GitHub releases page to pick a file
// themselves. Every new build changes the installer's filename (it embeds
// the version — see CLAUDE.md's version-bump rule), so a fixed URL would
// go stale on every release; this always resolves against whatever is
// currently the latest *published* release, live, on each click.
//
// Only sees published releases — GitHub's own "latest release" API never
// returns a draft (see release-desktop-app.yml: every build lands as a
// draft first, for a human to verify before it reaches real users) — so
// until one is published, every platform falls back to the releases page
// exactly like the old static links did.
export const GET = withErrorHandling(async (req: NextRequest) => {
  const platform = req.nextUrl.searchParams.get("platform");
  const matcher = platform ? PLATFORM_MATCHERS[platform] : undefined;
  if (!matcher) {
    return NextResponse.redirect(RELEASES_PAGE);
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      // Short cache: fresh enough that publishing a new release shows up
      // within minutes, without hitting GitHub's API on every single click.
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      return NextResponse.redirect(RELEASES_PAGE);
    }

    const release = (await res.json()) as { assets?: GitHubReleaseAsset[] };
    const asset = release.assets?.find((a) => matcher(a.name));
    return NextResponse.redirect(asset?.browser_download_url ?? RELEASES_PAGE);
  } catch (err) {
    console.error("[api/download] Could not resolve latest release asset:", err);
    return NextResponse.redirect(RELEASES_PAGE);
  }
});
