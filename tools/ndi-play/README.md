# ndi-play

Custom SDL2-based NDI receiver used by the FRC projector display.
Compiled binary is shipped to thin clients via the GCS asset bucket
(see `client/install.sh` `NDI_TOOLS_URL`). This source lives here
for version control; the NDI SDK itself is downloaded separately.

## Build

```bash
# Get the NDI SDK from https://ndi.video/for-developers/ndi-sdk/
# Extract to ./NDI\ SDK\ for\ Linux/

g++ -O2 -o ndi-play ndi-play.cpp \
  -I"NDI SDK for Linux/include" \
  -L"NDI SDK for Linux/lib/x86_64-linux-gnu" \
  -Wl,-rpath,/usr/local/lib \
  -lndi -lSDL2
```

## Usage

```
ndi-play "Source Name (host)" [high|low] [--window WxH+X+Y]
```

- Without `--window`: fullscreen on `SDL_VIDEO_FULLSCREEN_DISPLAY`.
- With `--window`: borderless always-on-top window at the given
  framebuffer pixels; used to overlay NDI in a corner of a kiosk page.

## Build environment on home server

`/home/filip/ndi-build` holds the SDK + build artifacts (~313 MB).
Not in this repo because of size.
