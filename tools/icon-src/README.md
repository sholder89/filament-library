# App icon artwork

Drop the two source images here, then run the build from the project root:

```bash
node tools/build-icons.mjs
```

| File | Used for |
|---|---|
| `icon-dark.png` | The dark-background version. **This is the default** — it becomes the home-screen icon and the manifest icons. |
| `icon-light.png` | The light-background version, used for the browser tab icon in light mode. |

Square PNGs, 1024×1024 ideal. The script downsamples with a box filter and
writes every size into `public/icons/`, so nothing else needs editing.

Keep the sources committed — the generated PNGs are derived from them and this
is the only record of the originals.

## Why the dark one is the default

iOS home-screen icons can't switch between light and dark. Whatever is pinned
stays pinned, so one version has to win. The dark artwork holds up on both light
and dark home screens; the light version would look washed out against a dark
wallpaper.
