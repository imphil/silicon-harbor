"""Sphinx configuration for the Silicon Harbor documentation.

Build: npm run docs (needs the packages in docs/requirements.txt).
"""

project = "Silicon Harbor"
author = "The Silicon Harbor authors"
copyright = "2026, The Silicon Harbor authors"

extensions = ["myst_parser"]
source_suffix = {".md": "markdown"}
root_doc = "index"
exclude_patterns = ["_build", ".venv", "requirements.txt"]

# MyST: GitHub-style anchors for "#heading" links, ::: fences for admonitions.
myst_heading_anchors = 3
myst_enable_extensions = ["colon_fence", "deflist"]

html_theme = "carbon"
html_title = "Silicon Harbor"
html_theme_options = {
    "repository_url": "https://github.com/imphil/silicon-harbor",
    "toc_depth": "2",
}
