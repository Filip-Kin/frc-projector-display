// ndi-play — NDI receiver with audio, bandwidth selection, optional windowed mode
// Usage: ndi-play "Source Name (hostname)" [high|low] [--window WxH+X+Y]
//
// Without --window the player goes fullscreen on the X display selected by
// SDL_VIDEO_FULLSCREEN_DISPLAY. With --window it creates a borderless
// always-on-top window at the requested framebuffer position — used by the
// FRC daemon to overlay NDI in a corner of a kiosk page.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <atomic>
#include <string>
#include <SDL2/SDL.h>
#include "Processing.NDI.Lib.h"

static std::atomic<bool> running{true};
static void sighandler(int) { running = false; }

struct WindowGeom { int w, h, x, y; };

static bool parse_geom(const char* s, WindowGeom& out) {
    return sscanf(s, "%dx%d+%d+%d", &out.w, &out.h, &out.x, &out.y) == 4
           && out.w > 0 && out.h > 0;
}

// Convert NDI's planar float32 (channel-per-block) to SDL's interleaved float32
static void deinterleave_to_interleaved(const float* src, float* dst, int channels, int samples) {
    for (int s = 0; s < samples; s++)
        for (int c = 0; c < channels; c++)
            dst[s * channels + c] = src[c * samples + s];
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: ndi-play \"Source Name\" [high|low] [--window WxH+X+Y]\n");
        return 1;
    }
    const char* source_name = argv[1];
    bool low_bandwidth = false;
    bool windowed = false;
    WindowGeom geom = {0,0,0,0};

    for (int i = 2; i < argc; i++) {
        std::string a = argv[i];
        if (a == "low" || a == "high") {
            low_bandwidth = (a == "low");
        } else if (a == "--window" && i + 1 < argc) {
            if (!parse_geom(argv[++i], geom)) {
                fprintf(stderr, "[ndi-play] bad --window spec '%s' (expected WxH+X+Y)\n", argv[i]);
                return 1;
            }
            windowed = true;
        }
    }

    signal(SIGTERM, sighandler);
    signal(SIGINT,  sighandler);
    signal(SIGKILL, SIG_DFL); // SIGKILL can't be caught — just document

    if (!NDIlib_initialize()) {
        fprintf(stderr, "[ndi-play] NDI not supported on this CPU\n");
        return 1;
    }

    NDIlib_source_t source;
    source.p_ndi_name    = source_name;
    source.p_url_address = nullptr;

    NDIlib_recv_create_v3_t recv_desc = {};
    recv_desc.source_to_connect_to = source;
    recv_desc.color_format         = NDIlib_recv_color_format_BGRX_BGRA;
    recv_desc.bandwidth            = low_bandwidth
                                       ? NDIlib_recv_bandwidth_lowest
                                       : NDIlib_recv_bandwidth_highest;
    recv_desc.allow_video_fields   = false;
    recv_desc.p_ndi_recv_name      = "ndi-play";

    NDIlib_recv_instance_t pRecv = NDIlib_recv_create_v3(&recv_desc);
    if (!pRecv) {
        fprintf(stderr, "[ndi-play] Failed to create NDI receiver\n");
        NDIlib_destroy();
        return 1;
    }
    fprintf(stderr, "[ndi-play] Connecting: %s (%s bandwidth)\n",
            source_name, low_bandwidth ? "low" : "high");

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) < 0) {
        fprintf(stderr, "[ndi-play] SDL_Init failed: %s\n", SDL_GetError());
        NDIlib_recv_destroy(pRecv);
        NDIlib_destroy();
        return 1;
    }

    Uint32 win_flags = SDL_WINDOW_SHOWN;
    int win_x, win_y, win_w, win_h;
    if (windowed) {
        win_flags |= SDL_WINDOW_BORDERLESS | SDL_WINDOW_ALWAYS_ON_TOP;
        win_x = geom.x; win_y = geom.y;
        win_w = geom.w; win_h = geom.h;
        fprintf(stderr, "[ndi-play] Windowed: %dx%d+%d+%d\n", win_w, win_h, win_x, win_y);
    } else {
        win_flags |= SDL_WINDOW_FULLSCREEN_DESKTOP;
        win_x = SDL_WINDOWPOS_UNDEFINED; win_y = SDL_WINDOWPOS_UNDEFINED;
        win_w = 1920; win_h = 1080;
    }
    SDL_Window* window = SDL_CreateWindow("NDI Monitor", win_x, win_y, win_w, win_h, win_flags);
    if (!window) {
        fprintf(stderr, "[ndi-play] SDL_CreateWindow: %s\n", SDL_GetError());
        SDL_Quit(); NDIlib_recv_destroy(pRecv); NDIlib_destroy();
        return 1;
    }

    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
    if (!renderer) renderer = SDL_CreateRenderer(window, -1, 0);
    SDL_ShowCursor(SDL_DISABLE);

    // Audio device — opened lazily on first audio frame so we match NDI's format
    SDL_AudioDeviceID audio_dev   = 0;
    int               audio_freq  = 0;
    int               audio_chans = 0;

    SDL_Texture* texture = nullptr;
    int tex_w = 0, tex_h = 0;

    // Scratch buffer for interleaving audio (reused each frame)
    float* interleave_buf     = nullptr;
    int    interleave_buf_len = 0;

    fprintf(stderr, "[ndi-play] Waiting for first frame\n");

    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) running = false;
            if (e.type == SDL_KEYDOWN &&
                (e.key.keysym.sym == SDLK_q || e.key.keysym.sym == SDLK_ESCAPE))
                running = false;
        }
        if (!running) break;

        NDIlib_video_frame_v2_t video = {};
        NDIlib_audio_frame_v3_t audio = {};

        NDIlib_frame_type_e ftype = NDIlib_recv_capture_v3(pRecv, &video, &audio, nullptr, 100);

        if (ftype == NDIlib_frame_type_video) {
            if (texture && (tex_w != video.xres || tex_h != video.yres)) {
                SDL_DestroyTexture(texture); texture = nullptr;
            }
            if (!texture) {
                tex_w = video.xres; tex_h = video.yres;
                texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_BGRA32,
                                            SDL_TEXTUREACCESS_STREAMING, tex_w, tex_h);
                fprintf(stderr, "[ndi-play] Video: %dx%d\n", tex_w, tex_h);
            }
            if (texture) {
                SDL_UpdateTexture(texture, nullptr, video.p_data, video.line_stride_in_bytes);
                SDL_RenderClear(renderer);
                SDL_RenderCopy(renderer, texture, nullptr, nullptr);
                SDL_RenderPresent(renderer);
            }
            NDIlib_recv_free_video_v2(pRecv, &video);

        } else if (ftype == NDIlib_frame_type_audio) {
            int ch = audio.no_channels;
            int ns = audio.no_samples;

            // Open audio device on first frame, matching NDI's format
            if (!audio_dev || audio_freq != audio.sample_rate || audio_chans != ch) {
                if (audio_dev) SDL_CloseAudioDevice(audio_dev);
                SDL_AudioSpec want = {}, got = {};
                want.freq     = audio.sample_rate;
                want.format   = AUDIO_F32SYS;
                want.channels = (Uint8)ch;
                want.samples  = 1024;
                want.callback = nullptr;
                audio_dev = SDL_OpenAudioDevice(nullptr, 0, &want, &got, 0);
                if (audio_dev) {
                    SDL_PauseAudioDevice(audio_dev, 0);
                    audio_freq  = audio.sample_rate;
                    audio_chans = ch;
                    fprintf(stderr, "[ndi-play] Audio: %d Hz, %d ch\n", audio_freq, ch);
                }
            }

            if (audio_dev && audio.p_data) {
                int needed = ns * ch;
                if (needed > interleave_buf_len) {
                    delete[] interleave_buf;
                    interleave_buf     = new float[needed];
                    interleave_buf_len = needed;
                }
                deinterleave_to_interleaved(reinterpret_cast<const float*>(audio.p_data), interleave_buf, ch, ns);
                SDL_QueueAudio(audio_dev, interleave_buf, (Uint32)(needed * sizeof(float)));
            }
            NDIlib_recv_free_audio_v3(pRecv, &audio);

        } else if (ftype == NDIlib_frame_type_error) {
            fprintf(stderr, "[ndi-play] Receive error — reconnecting\n");
            SDL_Delay(200);
        }
    }

    delete[] interleave_buf;
    if (audio_dev) SDL_CloseAudioDevice(audio_dev);
    if (texture)   SDL_DestroyTexture(texture);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    NDIlib_recv_destroy(pRecv);
    NDIlib_destroy();
    fprintf(stderr, "[ndi-play] Exited\n");
    return 0;
}
