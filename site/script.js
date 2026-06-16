const downloadLink = document.querySelector("[data-download]");
const releaseNote = document.querySelector("[data-release-note]");

async function hydrateLatestRelease() {
  if (!downloadLink || !releaseNote) return;

  try {
    const response = await fetch(
      "https://api.github.com/repos/Brehove/margent/releases/latest",
      { headers: { Accept: "application/vnd.github+json" } },
    );

    if (!response.ok) {
      downloadLink.href = "https://github.com/Brehove/margent/releases";
      releaseNote.textContent =
        "The Mac download will appear here after the first signed release.";
      return;
    }

    const release = await response.json();
    const dmgAsset = release.assets?.find((asset) => asset.name === "Margent.dmg");

    if (dmgAsset?.browser_download_url) {
      downloadLink.href = dmgAsset.browser_download_url;
      releaseNote.textContent = `Latest release: ${release.tag_name}.`;
      return;
    }

    downloadLink.href = release.html_url || "https://github.com/Brehove/margent/releases";
    releaseNote.textContent =
      "Open the latest release to choose the available Mac download.";
  } catch {
    releaseNote.textContent = "Downloads are served from GitHub Releases.";
  }
}

hydrateLatestRelease();

