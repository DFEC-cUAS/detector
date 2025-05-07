# GPU-accelerated MobileNet on Electron

#### 2024-'25 author: Geoffrey Stentiford

This program receives the webcam stream and runs a version of MobileNet SSD trained specifically on drones. It draws a bounding box around the thing most likely to be a drone. The dimensions of this box, as well as metadata, are passed to C3Mission using the [`ipc.js`](/ipc.js) worker script on the detector side and the `server` plugin on the C3Mission side.

## Requirements
This branch requires a stream being broadcast over the network by [`ws-relay`](https://github.com/DFEC-cUAS/ws-relay). 

The [`camera_stream.sh` script](https://github.com/DFEC-cUAS/cuas_main/tree/main#camera-scripts) on the ground station laptop already handles this for you.

## Installation
Ensure you have Node.JS installed. Inside the repository folder, do `npm install`.

## Usage  
WebGPU backend: `npm run webgpu` (not working on Linux)  
WebGL backend: `npm run webgl` (currently used)  
WebAssembly backend: `npm run wasm` (CPU-only, okay performance)  
JavaScript backend: `npm run js` (CPU-only, lackluster performance)  

## Interfacing to C3Mission/AgentCore
The application passes data to C3Mission over a TCP connection on `127.0.0.1:1337`. On the C3Mission side, communication is handled by the `server` plugin. For more information, see [the `server.py` documentation](https://github.com/DFEC-cUAS/cuas_main/blob/main/agent_core/server.md).

If the IPC server is not running, the detector will still operate just fine. The only side-effect is that there will be a lot of errors in the console from `ipc.js` complaining about being unable to connect to the server.

## Design

### Why Electron?
This uses Electron to run TensorFlow.js. Electron instead of plain Node.JS is needed to run the WebGPU and WebGL backends. Google's repository for TensorFlow.js does contain some work for using headless OpenGL to accelerate models on plain Node.JS, but the work seems to have stalled years ago.

### Files
These scripts set up and launch the application, each using a different TensorFlow.js backend:
- `webgl.js`, paired with `gl_worker.html`
- `webgpu.js`, paired with `gpu_worker.html`
- `wasm.js`, paired with `wasm_worker.html`
- `jsonly.js`, paired with `js_worker.html`

For simplicitly, I recommend just using the `npm run` commands to launch the detector.

As much code as possible is shared between these four versions of the application within `window.js` and `shared.js`. The former is referenced by `<script>` tags in each HTML file, while the latter is a library whose modules are imported by the former.

### Image Ingestion
The application works in conjunction with [`ws-relay`](https://github.com/DFEC-cUAS/ws-relay), a small program which reads image data piped to its `stdin` by FFmpeg and streams that image data over a WebSocket. Because this image data is in JPEG (or PNG), the application uses an `<img>` tag to decode the image. This is the image on the left in the application window.

In order to scale the image and fit it into the 300x300 size needed by MobileNet, the application has an offscreen canvas onto which the scaled image is rendered after every frame update. This process is deliberately decoupled from the main loop which runs the inference so that inference isn't blocked by graphics operations. The bitmap of the offscreen canvas is used to create the input tensor of the neural network.

### Filtering and Heuristics
The MobileNet SSD spits out many, many detections per image, each with its own bounding box and confidence values.
Many heuristics are used to reject false positives, including bounding box shape and size, variable confidence thresholds depending on bounding box size, and even change in position from the last loop iteration.

### Track States
The bounding box drawn on the screen can be green, blue, purple, or red. Green means an active track, where the detector is able to keep track of the drone for consecutive image frames. Blue signifies that the track is good but not continuous, as in the detector may lose the drone for a few frames at a time. Purple is a "stale" track; that is, the track has been lost for several frames but the detector still assumes the drone is roughly in the same area, so the post-inference heuristics still prefer to look in that region of the image and the jitter-smoothing is still active. Lastly, red represents a track that has been completely lost—jitter-smoothing is bypassed and no bias is given to the last-known location.

The track state is passed to C3Mission along with the confidence.

### asm.js Modules
If you look in [`shared.js`](/shared.js), you'll see a lot of very unusual JavaScript inside the `exports.asmExport` block. This is because this application makes heavy use of asm.js, a strongly-typed, manually-memory-managed, statically-linked, ahead-of-time-compiled subset of JavaScript that is faster than normal JavaScript.

Because only numerical values may be passed as parameters to functions written in asm.js and asm.js functions can only return a single number, for bulk values, shared memory is used to communicate between the asm.js modules and the rest of the code. In `shared.js`, this blob of memory is allocated as an `ArrayBuffer` and cast as a single large `Float64Array` for use inside asm.js code. Additionally, it is cast into smaller `Float64Array`s, each covering only part of the memory space, which are exported and used by `window.js` to access the values in a more straightforward way.

Background on JavaScript manual memory allocation:
 - [W3Schools: JavaScript Typed Array Reference](https://www.w3schools.com/jsref/jsref_obj_typed_array.asp)
 - [MDN Web Docs: ArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer)
 - [MDN Web Docs: TypedArray](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypedArray)

[See here for details on writing asm.js.](https://github.com/zbjornson/human-asmjs)

## Known issues
The WebGPU backend, despite nominally being the fastest, has the most lag due to a bottleneck in copying data to and from the GPU. However, when deployed onto a device with much more constrained CPU resources, it should reveal itself to be much faster than CPU-only execution, I/O constraints notwithstanding.

Presently, the detector does not perform very well on the Raspberry Pi 5. WebGPU support on the Pi is broken, limiting us to the less-efficient WebGL backend. The CPU-only backends are even worse.

## Cat

Here is a picture of my cat used as a test input in the very earliest stages of development.

![Geoff's cat](/cat_small.jpg)