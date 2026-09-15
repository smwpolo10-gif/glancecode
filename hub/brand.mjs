// Every user-visible and on-disk name lives here, so a rename is a one-file change.
export const BRAND = {
  name: "glancecode", // CLI command, npm package, config and data folder names
  displayName: "GlanceCode", // Even Hub listing and glasses header (20 chars max)
  tagline: "Claude Code sessions on your Even Realities G2 glasses",
  tmuxSocket: "glancecode", // dedicated tmux server: tmux -L glancecode
  serviceLabel: "dev.glancecode.hub", // launchd label
  envPrefix: "GLANCECODE", // GLANCECODE_CONFIG_DIR, GLANCECODE_HOOK_PORT, ...
  // Earlier names this project used on disk, migrated on first run. Add the old
  // values here when renaming, so existing installs carry over.
  legacy: {
    configDirs: [],
    serviceLabels: [],
    hookScripts: [],
  },
};

export const env = (key) => process.env[`${BRAND.envPrefix}_${key}`];
