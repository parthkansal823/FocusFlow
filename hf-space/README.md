---
title: FocusFlow Judge
emoji: 🎯
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: Local-style Qwen3 classification API for FocusFlow
---

# FocusFlow judge: your own classification server

This folder runs [llama.cpp](https://github.com/ggml-org/llama.cpp)'s OpenAI-compatible
server with **Qwen3**, with reasoning disabled for faster classification. The extension sends it a page's metadata
(title, description, YouTube category…) and it answers `ALLOW` or `BLOCK`.

There is no metered token-provider API. Hosting limits, costs and availability
depend on your selected service. A free CPU Space is not an unlimited-speed backend.

## Option 1: Hugging Face Space (free, easiest)

1. Go to <https://huggingface.co/new-space>, pick **Docker** → **Blank**, hardware **CPU basic (free)**.
   Keep the Space **public** (see "Access token").
2. Upload `Dockerfile` and this `README.md`.
3. Wait for the build (a few minutes; it downloads the model once).
4. In FocusFlow → Settings, choose **Hugging Face Space**, set the server URL to
   `https://<your-username>-<space-name>.hf.space/v1` and the model to `qwen3`, then **Save**.

CPU inference and cold starts can be slow. FocusFlow's local-first classifier
handles clear pages without waiting for the Space; ambiguous pages still need
the server. For a lighter model, set the build argument `MODEL_URL` to the
Qwen3-0.6B file listed in the Dockerfile and rebuild the image.

Spaces may sleep while idle. FocusFlow attempts a warm-up when the browser starts;
if the server is not ready before the request timeout, the strict offline model decides.

## Option 2: your own Docker server

[Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) includes an Ampere VM with
**4 CPUs and 24 GB RAM**, free with no usage limit (sign-up asks for a card for verification).

```bash
# on the VM (Ubuntu), after installing Docker:
git clone https://github.com/parthkansal823/FocusFlow && cd FocusFlow
docker build -t focusflow-llm hf-space
docker run -d --restart=always -p 7860:7860 -e LLAMA_API_KEY=<long-random-secret> focusflow-llm
```

Open port 7860 in the VM's security list and firewall, then in FocusFlow choose **Your server**:
URL `http://<vm-ip>:7860/v1`, model `qwen3`, access token `<long-random-secret>`.
With 4 cores, Qwen3-4B (`--build-arg MODEL_URL=...Qwen3-4B-Q4_K_M.gguf`) is also usable.

## Access token (recommended)

Anyone who knows the URL could use your server. Set `LLAMA_API_KEY`
(a **secret** in the Space settings, or `-e` with Docker) to any long random value and paste
the same value into FocusFlow's **Access token** field. (A *private* Space would need a
Hugging Face token in the same header, which llama.cpp can't check, so use a public
Space + `LLAMA_API_KEY`.)
