# ── omt-play: ndi-play for OMT and omtx (players/omt-play) ───────────────────
# Built on Debian 13 like the thin clients, so its SDL2 and libavcodec links match what the
# boxes' ffmpeg package installs.
FROM debian:trixie AS omtplay
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git clang lld zlib1g-dev g++ \
    libsdl2-dev libavcodec-dev libavutil-dev libswscale-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/di.sh \
 && bash /tmp/di.sh --channel 8.0 --install-dir /opt/dotnet
ENV PATH=/opt/dotnet:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

# libomtnet comes from omtx (OMT with H.264/HEVC passthrough); libomt (its C exports)
# expects it as a sibling directory.
ARG OMTX_REV=v0.2.4
ARG LIBOMT_REV=bb4b67b
ARG LIBVMX_REV=a1828cb
WORKDIR /src
RUN git clone https://github.com/Filip-Kin/omtx.git && git -C omtx checkout $OMTX_REV && mv omtx/libomtnet libomtnet \
 && git clone https://github.com/openmediatransport/libomt.git && git -C libomt checkout $LIBOMT_REV \
 && git clone https://github.com/openmediatransport/libvmx.git && git -C libvmx checkout $LIBVMX_REV

# libvmx (VMX, stock OMT's codec). Only the AVX2 file gets AVX2/BMI/LZCNT; the codec picks the
# path at runtime. Upstream's SSE path calls _lzcnt_u64 too: on a CPU without LZCNT (the boxes'
# Celeron J1800) that runs as BSR and VMX decodes to green garbage, so there __lzcnt64 becomes
# __builtin_clzll (0 -> 64).
RUN mkdir /out && cd libvmx/src \
 && sed -i 's|^#include <x86intrin.h>$|#include <x86intrin.h>\n#ifndef __LZCNT__\n#define __lzcnt64(t) ((t) ? (unsigned long long)__builtin_clzll(t) : 64ULL)\n#endif|' vmxcodec_x86.h \
 && clang++ -O3 -std=c++17 -fdeclspec -fPIC -msse4.2 -mssse3 -c vmxcodec.cpp      -o /tmp/vmx.o \
 && clang++ -O3 -std=c++17 -fdeclspec -fPIC -msse4.2 -mssse3 -c vmxcodec_x86.cpp  -o /tmp/vmx_x86.o \
 && clang++ -O3 -std=c++17 -fdeclspec -fPIC -mavx2 -mbmi -mbmi2 -mlzcnt -c vmxcodec_avx2.cpp -o /tmp/vmx_avx2.o \
 && clang++ -shared -fPIC -Wl,-rpath,'$ORIGIN' /tmp/vmx.o /tmp/vmx_x86.o /tmp/vmx_avx2.o -o /out/libvmx.so

# libomt: .NET 8 NativeAOT build of libomtnet with C exports. Invariant globalization drops
# the libicu dependency.
RUN cd libomtnet && dotnet build libomtnet.csproj -c Release \
 && cd ../libomt && dotnet publish libomt.csproj -r linux-x64 -c Release -p:InvariantGlobalization=true \
 && cp bin/Release/net8.0/linux-x64/native/libomt.so libomt.h /out/

COPY players/omt-play/ /build/
RUN cd /build && g++ -O2 -Wall -o /out/omt-play omt-play.cpp -I/out -L/out -lomt -lSDL2 -lavcodec -lavutil -lswscale \
 && install -m 755 omt-play-wrapper /out/omt-play-wrapper && rm /out/libomt.h

# ── Server ────────────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine
WORKDIR /app

# ── Server dependencies ───────────────────────────────────────────────────────
COPY server/package.json ./
RUN bun install --production

# ── Client source (bundled for self-hosted distribution) ─────────────────────
COPY client/ ./client-dist/
# omt-play ships in the client bundle, so boxes get it with a normal client update
COPY --from=omtplay /out/ ./client-dist/players/omt/
# Bundle the controller page so the daemon can serve it offline
COPY server/public/control.html ./client-dist/public/control.html

# ── Server source + public ────────────────────────────────────────────────────
COPY server/src/ ./src/
COPY server/public/ ./public/

# Create client.tar.gz (no node_modules — thin client installs them after)
RUN tar -czf ./public/client.tar.gz --exclude=node_modules --exclude=.git -C ./client-dist .

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
