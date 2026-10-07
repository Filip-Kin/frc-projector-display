// omt-play — OMT (Open Media Transport) and omtx receiver with audio, quality
// selection, optional windowed mode. Same shape as ndi-play.
// Usage: omt-play "host:port" [high|medium|low] [--window WxH+X+Y] [--stats]
//
// Stock OMT sends VMX, which libomt decodes to UYVY. omtx (github.com/Filip-Kin/omtx)
// is OMT carrying H.264/HEVC; libomt here is built from omtx's libomtnet, which hands
// those frames over still compressed, and they are decoded with libavcodec.
//
// The source may be given as omt://host:port, omtx://host:port, host:port, or a
// discovery name "HOSTNAME (Source Name)". host:port is turned into omt://host:port:
// libomt treats anything that is not an omt:// URL as a discovery name and waits for
// it forever, which is what broke the old ffplay-omt wrapper. omtx:// is the same
// TCP protocol, so it becomes omt:// too.
//
// high/medium/low sets the receiver's suggested quality
// (OMTQuality_High/Medium/Low). The
// sender only follows it when its own quality is left on Default.
//
// Without --window the player goes fullscreen on the X display selected by
// SDL_VIDEO_FULLSCREEN_DISPLAY. With --window it creates a borderless
// always-on-top window at the requested framebuffer position, used by the FRC
// daemon to overlay the stream in a corner of a kiosk page.
//
// --stats prints frame counts every 5 s to stderr (testing only: the daemon
// does not drain stderr, so a long-running player must stay quiet).

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <atomic>
#include <string>
#include <SDL2/SDL.h>
#include "libomt.h"
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

// omtx codecs (not in upstream libomt.h): FourCC 'H264' and 'HEVC'
static const int OMTCodec_H264 = 0x34363248;
static const int OMTCodec_HEVC = 0x43564548;

// H.264/HEVC decoder for omtx frames. Slice threads only: frame threads would hold
// pictures back and add latency. Pictures come out as I420 for an IYUV texture.
struct Decoder {
    AVCodecContext* ctx = nullptr;
    AVPacket* pkt = nullptr;
    AVFrame* frame = nullptr;
    AVFrame* shown = nullptr;   // the newest decoded picture (receive_frame clears `frame` when it finds none)
    AVFrame* i420 = nullptr;
    SwsContext* sws = nullptr;
    int codec = 0;

    bool open(int omtCodec) {
        close();
        const AVCodec* c = avcodec_find_decoder(omtCodec == OMTCodec_HEVC ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264);
        if (!c) return false;
        ctx = avcodec_alloc_context3(c);
        ctx->flags |= AV_CODEC_FLAG_LOW_DELAY;
        ctx->thread_type = FF_THREAD_SLICE;
        ctx->thread_count = 0;
        if (avcodec_open2(ctx, c, nullptr) < 0) { close(); return false; }
        pkt = av_packet_alloc(); frame = av_frame_alloc(); shown = av_frame_alloc(); i420 = av_frame_alloc();
        codec = omtCodec;
        return true;
    }
    void close() {
        if (ctx) avcodec_free_context(&ctx);
        if (pkt) av_packet_free(&pkt);
        if (frame) av_frame_free(&frame);
        if (shown) av_frame_free(&shown);
        if (i420) av_frame_free(&i420);
        if (sws) { sws_freeContext(sws); sws = nullptr; }
        codec = 0;
    }
    // Decode one access unit; returns an I420 picture or nullptr (none ready / error).
    AVFrame* decode(const void* data, int length) {
        pkt->data = (uint8_t*)data; pkt->size = length;
        int r = avcodec_send_packet(ctx, pkt);
        pkt->data = nullptr; pkt->size = 0;
        if (r < 0 && r != AVERROR(EAGAIN)) return nullptr;
        AVFrame* out = nullptr;
        while (avcodec_receive_frame(ctx, frame) == 0) {
            av_frame_unref(shown);
            av_frame_move_ref(shown, frame);
            if (shown->format == AV_PIX_FMT_YUV420P || shown->format == AV_PIX_FMT_YUVJ420P) { out = shown; continue; }
            // Anything else (4:2:2, 10-bit) is converted to I420 for the texture
            if (i420->width != shown->width || i420->height != shown->height) {
                av_frame_unref(i420);
                i420->format = AV_PIX_FMT_YUV420P; i420->width = shown->width; i420->height = shown->height;
                av_frame_get_buffer(i420, 32);
            }
            sws = sws_getCachedContext(sws, shown->width, shown->height, (AVPixelFormat)shown->format,
                                       shown->width, shown->height, AV_PIX_FMT_YUV420P, SWS_BILINEAR, nullptr, nullptr, nullptr);
            sws_scale(sws, shown->data, shown->linesize, 0, shown->height, i420->data, i420->linesize);
            out = i420;
        }
        return out;
    }
};

static std::atomic<bool> running{true};
static void sighandler(int) { running = false; }

struct WindowGeom { int w, h, x, y; };

static bool parse_geom(const char* s, WindowGeom& out) {
    return sscanf(s, "%dx%d+%d+%d", &out.w, &out.h, &out.x, &out.y) == 4
           && out.w > 0 && out.h > 0;
}

// Convert OMT's planar float32 (channel-per-block) to SDL's interleaved float32
static void planar_to_interleaved(const float* src, float* dst, int channels, int samples) {
    for (int s = 0; s < samples; s++)
        for (int c = 0; c < channels; c++)
            dst[s * channels + c] = src[c * samples + s];
}

static std::string normalise_address(const char* in) {
    std::string a = in;
    if (a.rfind("omt://", 0) == 0) return a;
    if (a.rfind("omtx://", 0) == 0) return "omt://" + a.substr(7);
    // A discovery name has the form "HOSTNAME (Source Name)"
    if (a.find('(') != std::string::npos) return a;
    return "omt://" + a;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: omt-play \"host:port\" [high|medium|low] [--window WxH+X+Y] [--stats]\n");
        return 1;
    }
    const std::string address = normalise_address(argv[1]);
    OMTQuality quality = OMTQuality_High;
    const char* quality_name = "high";
    bool windowed = false;
    bool stats = false;
    WindowGeom geom = {0,0,0,0};

    for (int i = 2; i < argc; i++) {
        std::string a = argv[i];
        if (a == "high" || a == "medium" || a == "low") {
            quality = a == "low" ? OMTQuality_Low : a == "medium" ? OMTQuality_Medium : OMTQuality_High;
            quality_name = argv[i];
        } else if (a == "--window" && i + 1 < argc) {
            if (!parse_geom(argv[++i], geom)) {
                fprintf(stderr, "[omt-play] bad --window spec '%s' (expected WxH+X+Y)\n", argv[i]);
                return 1;
            }
            windowed = true;
        } else if (a == "--stats") {
            stats = true;
        }
    }

    signal(SIGTERM, sighandler);
    signal(SIGINT,  sighandler);

    const OMTFrameType want = (OMTFrameType)(OMTFrameType_Video | OMTFrameType_Audio);
    omt_receive_t* recv = omt_receive_create(address.c_str(), want,
                                             OMTPreferredVideoFormat_UYVY, OMTReceiveFlags_None);
    if (!recv) {
        fprintf(stderr, "[omt-play] Failed to create OMT receiver (see ~/.OMT/logs)\n");
        return 1;
    }
    omt_receive_setsuggestedquality(recv, quality);
    fprintf(stderr, "[omt-play] Connecting: %s (%s quality)\n",
            address.c_str(), quality_name);

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) < 0) {
        fprintf(stderr, "[omt-play] SDL_Init failed: %s\n", SDL_GetError());
        omt_receive_destroy(recv);
        return 1;
    }

    Uint32 win_flags = SDL_WINDOW_SHOWN;
    int win_x, win_y, win_w, win_h;
    if (windowed) {
        win_flags |= SDL_WINDOW_BORDERLESS | SDL_WINDOW_ALWAYS_ON_TOP;
        win_x = geom.x; win_y = geom.y;
        win_w = geom.w; win_h = geom.h;
        fprintf(stderr, "[omt-play] Windowed: %dx%d+%d+%d\n", win_w, win_h, win_x, win_y);
    } else {
        win_flags |= SDL_WINDOW_FULLSCREEN_DESKTOP;
        win_x = SDL_WINDOWPOS_UNDEFINED; win_y = SDL_WINDOWPOS_UNDEFINED;
        win_w = 1920; win_h = 1080;
    }
    SDL_Window* window = SDL_CreateWindow("OMT Monitor", win_x, win_y, win_w, win_h, win_flags);
    if (!window) {
        fprintf(stderr, "[omt-play] SDL_CreateWindow: %s\n", SDL_GetError());
        SDL_Quit(); omt_receive_destroy(recv);
        return 1;
    }

    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
    if (!renderer) renderer = SDL_CreateRenderer(window, -1, 0);
    SDL_ShowCursor(SDL_DISABLE);
    // BT.601 below 720 lines, BT.709 at and above, which is also libomt's default
    SDL_SetYUVConversionMode(SDL_YUV_CONVERSION_AUTOMATIC);

    // Audio device — opened lazily on first audio frame so we match OMT's format
    SDL_AudioDeviceID audio_dev   = 0;
    int               audio_freq  = 0;
    int               audio_chans = 0;

    SDL_Texture* texture = nullptr;
    int tex_w = 0, tex_h = 0;
    Uint32 tex_fmt = 0;

    float* interleave_buf     = nullptr;
    int    interleave_buf_len = 0;

    Decoder dec;

    long long video_frames = 0, audio_frames = 0, audio_flushes = 0;
    Uint32 stats_at = SDL_GetTicks() + 5000;

    fprintf(stderr, "[omt-play] Waiting for first frame\n");

    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) running = false;
            if (e.type == SDL_KEYDOWN &&
                (e.key.keysym.sym == SDLK_q || e.key.keysym.sym == SDLK_ESCAPE))
                running = false;
        }
        if (!running) break;

        if (stats && SDL_GetTicks() >= stats_at) {
            OMTStatistics vs = {};
            omt_receive_getvideostatistics(recv, &vs);
            fprintf(stderr, "[omt-play] stats: video=%lld audio=%lld dropped=%lld audio_flushes=%lld queued_audio_ms=%u\n",
                    video_frames, audio_frames, (long long)vs.FramesDropped, audio_flushes,
                    audio_dev && audio_freq && audio_chans
                        ? (unsigned)(SDL_GetQueuedAudioSize(audio_dev) * 1000ull / (audio_freq * audio_chans * sizeof(float)))
                        : 0u);
            stats_at += 5000;
        }

        OMTMediaFrame* f = omt_receive(recv, want, 100);
        if (!f) continue;

        if (f->Type == OMTFrameType_Video && f->Data && f->DataLength > 0
            && (f->Codec == OMTCodec_H264 || f->Codec == OMTCodec_HEVC)) {
            // omtx: decode, then draw the I420 picture
            if (dec.codec != f->Codec && !dec.open(f->Codec)) {
                fprintf(stderr, "[omt-play] no decoder for %s\n", f->Codec == OMTCodec_HEVC ? "HEVC" : "H.264");
                continue;
            }
            AVFrame* pic = dec.decode(f->Data, f->DataLength);
            if (!pic) continue;
            if (texture && (tex_w != pic->width || tex_h != pic->height || tex_fmt != SDL_PIXELFORMAT_IYUV)) {
                SDL_DestroyTexture(texture); texture = nullptr;
            }
            if (!texture) {
                tex_w = pic->width; tex_h = pic->height; tex_fmt = SDL_PIXELFORMAT_IYUV;
                texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_IYUV, SDL_TEXTUREACCESS_STREAMING, tex_w, tex_h);
                fprintf(stderr, "[omt-play] Video: %dx%d %s %d/%d fps\n", tex_w, tex_h,
                        f->Codec == OMTCodec_HEVC ? "HEVC" : "H.264", f->FrameRateN, f->FrameRateD);
            }
            if (texture) {
                SDL_UpdateYUVTexture(texture, nullptr, pic->data[0], pic->linesize[0],
                                     pic->data[1], pic->linesize[1], pic->data[2], pic->linesize[2]);
                SDL_RenderClear(renderer);
                SDL_RenderCopy(renderer, texture, nullptr, nullptr);
                SDL_RenderPresent(renderer);
            }
            video_frames++;

        } else if (f->Type == OMTFrameType_Video && f->Data && f->DataLength > 0) {
            Uint32 fmt;
            if (f->Codec == OMTCodec_UYVY)                                 fmt = SDL_PIXELFORMAT_UYVY;
            else if (f->Codec == OMTCodec_BGRA || f->Codec == 0x58524742) fmt = SDL_PIXELFORMAT_BGRA32; // BGRA / BGRX
            else continue;

            if (texture && (tex_w != f->Width || tex_h != f->Height || tex_fmt != fmt)) {
                SDL_DestroyTexture(texture); texture = nullptr;
            }
            if (!texture) {
                tex_w = f->Width; tex_h = f->Height; tex_fmt = fmt;
                texture = SDL_CreateTexture(renderer, fmt, SDL_TEXTUREACCESS_STREAMING, tex_w, tex_h);
                fprintf(stderr, "[omt-play] Video: %dx%d %s %d/%d fps\n", tex_w, tex_h,
                        fmt == SDL_PIXELFORMAT_UYVY ? "UYVY" : "BGRA", f->FrameRateN, f->FrameRateD);
            }
            if (texture) {
                SDL_UpdateTexture(texture, nullptr, f->Data, f->Stride);
                SDL_RenderClear(renderer);
                SDL_RenderCopy(renderer, texture, nullptr, nullptr);
                SDL_RenderPresent(renderer);
            }
            video_frames++;

        } else if (f->Type == OMTFrameType_Audio && f->Data && f->Channels > 0) {
            int ch = f->Channels;
            int ns = f->SamplesPerChannel;

            if (!audio_dev || audio_freq != f->SampleRate || audio_chans != ch) {
                if (audio_dev) SDL_CloseAudioDevice(audio_dev);
                SDL_AudioSpec want_spec = {}, got = {};
                want_spec.freq     = f->SampleRate;
                want_spec.format   = AUDIO_F32SYS;
                want_spec.channels = (Uint8)ch;
                want_spec.samples  = 1024;
                want_spec.callback = nullptr;
                audio_dev = SDL_OpenAudioDevice(nullptr, 0, &want_spec, &got, 0);
                if (audio_dev) {
                    SDL_PauseAudioDevice(audio_dev, 0);
                    audio_freq  = f->SampleRate;
                    audio_chans = ch;
                    fprintf(stderr, "[omt-play] Audio: %d Hz, %d ch\n", audio_freq, ch);
                } else {
                    // Remember the format anyway so a missing device is not retried per frame
                    audio_freq  = f->SampleRate;
                    audio_chans = ch;
                    fprintf(stderr, "[omt-play] SDL_OpenAudioDevice: %s\n", SDL_GetError());
                }
            }

            if (audio_dev) {
                int needed = ns * ch;
                if (needed > interleave_buf_len) {
                    delete[] interleave_buf;
                    interleave_buf     = new float[needed];
                    interleave_buf_len = needed;
                }
                planar_to_interleaved(reinterpret_cast<const float*>(f->Data), interleave_buf, ch, ns);
                // Sender and sound card clocks drift apart over a long event.
                // Drop the queue if it passes 250 ms so latency cannot grow.
                const Uint32 max_queued = (Uint32)(audio_freq * ch * sizeof(float) / 4);
                if (SDL_GetQueuedAudioSize(audio_dev) > max_queued) {
                    SDL_ClearQueuedAudio(audio_dev);
                    audio_flushes++;
                }
                SDL_QueueAudio(audio_dev, interleave_buf, (Uint32)(needed * sizeof(float)));
            }
            audio_frames++;
        }
    }

    dec.close();
    delete[] interleave_buf;
    if (audio_dev) SDL_CloseAudioDevice(audio_dev);
    if (texture)   SDL_DestroyTexture(texture);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    omt_receive_destroy(recv);
    omt_shutdown();
    fprintf(stderr, "[omt-play] Exited (video=%lld audio=%lld)\n", video_frames, audio_frames);
    return 0;
}
