const fs = require('fs');
const tf = require('@tensorflow/tfjs-core');
const tflite = require('@tensorflow/tfjs-tflite');
const { asmExport, server, port, onError } = require('./shared');
const { converted, x_accum, y_accum, w_accum, h_accum, m1_accum, m2_accum, avgs, dimsAvg, midAvg,
    reformat, setAll, accConf, avgConf } = asmExport; // Compile asm.js modules
const osc = new OffscreenCanvas(300, 300); // Intermediate canvas
const ctx1 = osc.getContext('2d');
const worker = new Worker("ipc.js"); // IPC worker
let ipcUp = false; // Becomes true when connected to C3Mission server
let pause = false; // If image update is paused or not

worker.onmessage = msg => {
    if (msg.data == "connected") { // Waits for signal from ipc.js
        ipcUp = true;
    } else {
        console.error(msg.data); // Pass through any errors
    }
}

// Statically-allocate array for rolling averages of frame times
const rolling = new Float64Array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);

async function init() {
    console.log("Creating output renderer");
    /**
     * @type {HTMLCanvasElement}
     */
    const canvas = document.getElementById('display'); // On-screen output canvas
    /**
     * @type {CanvasRenderingContext2D}
     */
    const ctx2 = canvas.getContext("2d"); // Attach renderer

    // Draw placeholder graphic in output box
    ctx2.font = "15px Arial";
    ctx2.fillText("Waiting for webcam", 20, (canvas.height / 2) - 7);
    ctx2.lineWidth = 2;

    const desc = document.getElementById("class"); // Text output element
    document.querySelector("#pause").onclick = () => { pause = !pause }; // Listen for pause button

    console.log("Acquiring webcam");
    /**
     * @type {HTMLImageElement}
     */
    const webcam = document.getElementById('webcam'); // <img> element that renders MJPEG stream
    /**
     * @type {Blob}
     */
    let lastFrame = null; // Last received image frame
    var loadFlag = false; // If webcam image is loaded
    const updateFrame = function () { // Display received JPEG data in <img>
        webcam.src = webkitURL.createObjectURL(lastFrame);
        lastFrame = null;
    }

    /**
     * @param {WebSocket} ws 
     */
    function killSocket(ws) { // Resets WebSocket if there is error
        console.log("Closing current socket");
        ws.removeEventListener('message', ws.onmessage);
        ws.removeEventListener('error', ws.onerror);
        ws.close();
        loadFlag = false;
        setTimeout(createWebsocket, 200); // Connect again in 200ms
    }

    /**
     * @type {HTMLFormElement}
     */
    const ctrl = document.querySelector('#ctrl'); // Form for changing source IP
    document.querySelector('#change').onclick = () => {
        document.getElementById("submit").click(); // Click button if form submitted using enter key
    }

    webcam.onload = function () { // When <img> done rendering frame
        URL.revokeObjectURL(webcam.src); // Free the blob with the frame
        loadFlag = true; // Set flag
        // Copy to intermediate canvas (scaled to fit)
        ctx1.drawImage(webcam, 0, 0, webcam.naturalWidth, webcam.naturalHeight, 0, dy, dw, dh);
    };

    /**
     * @type {HTMLInputElement}
     */
    const source = document.querySelector('#source'); // Image server text field
    //source.value = "10.1.121.126:8080";
    source.value = "127.0.0.1:8080"; // Default image server is localhost
    /**
     * @type {NodeJS.Timeout}
     */
    var timer;
    let failCount = 0 | 0; // Force type to integer

    function createWebsocket() {
        console.log("Opening WebSocket to " + source.value);
        try {
            const ws = new WebSocket('ws://' + source.value + '/ws'); // Open WebSocket to server
            timer = null; // Prevent undefined value error
            ws.onerror = function (e) { // Handle WebSocket error
                console.error(ev); // Log error
                clearTimeout(timer); // Stop automatic connection reset
                killSocket(ws); // Kill broken socket
            }
            /**
             * @param {MessageEvent} e 
             */
            ws.onmessage = function (e) {
                if (timer) {
                    clearTimeout(timer);
                }
                if (!lastFrame) { // If no pending frame update
                    requestAnimationFrame(updateFrame); // Schedule repaint
                    lastFrame = e.data; // Extract image data from WebSocket message
                }
                timer = setTimeout(() => { // Automatically reset socket if no data for 1000ms
                    console.log("No data in 1000ms. Resetting socket.");
                    killSocket(ws);
                }, 1000);
            }
            if (ctrl.onsubmit) {
                ctrl.removeEventListener("submit", ctrl.onsubmit);
            }
            ctrl.onsubmit = e => {
                e.preventDefault();
                console.log("Changing server address");
                clearTimeout(timer); // Stop automatic connection reset
                killSocket(ws);
            }
            console.log("WebSocket opened");
            failCount = 0 | 0; // Reset fail count
        } catch (e) {
            failCount++; // Increment fail count
            if (failCount <= 1000) {
                console.error(e);
                setTimeout(createWebsocket, 100);
            } else { // Slow down retries after 1000 failures
                onError(e);
                setTimeout(createWebsocket, 1000);
            }
        }
    }
    createWebsocket();

    // Needed because TFlite compatibility layer is designed to work on an actual website
    console.log("Starting HTTP server to self-serve modules on port " + port.toString());
    server.listen(port); // Spin up server on randomized port
    console.log("Loading model");
    tflite.setWasmPath('http://127.0.0.1:' + new String(port) + '/'); // Set URL to local server
    const model = await tflite.loadTFLiteModel(fs.readFileSync("drone/drone-detect1.tflite")); // Load model
    console.log("Closing HTTP server")
    server.close(); // Close server after done loading modules
    server.removeAllListeners();

    console.log("Waiting for video start");
    /**
     * @param {Function} resolve 
     */
    const checkReady = function (resolve) { // Wait for first webcam frame
        if (!loadFlag) {
            setTimeout(() => checkReady(resolve), 50);
        } else {
            resolve();
        }
    }
    await new Promise( // Wrap it in a promise to make it await-able
        /**
         * @param {Function} resolve 
         */
        (resolve) => {
            checkReady(resolve);
        }
    );

    console.log("Running model");

    /**
     * @type {Number}
     */
    let weighted = { // Initial guess for loop times
        "cpu": 35.0,
        "webgl": 35.0,
        "webgpu": 45.0,
        "wasm": 35.0
    }[tf.getBackend()]; // Backends run at different speeds

    // Webcam dimensions
    const ratio = Math.min(canvas.width / webcam.width, canvas.height / webcam.height);
    const dy = (canvas.height - (webcam.height * ratio)) / 2;
    const dw = webcam.width * ratio;
    const dh = webcam.height * ratio;
    const [cvs_w, cvs_h] = [canvas.width, canvas.height];

    /**
     * @type {HTMLParagraphElement}
     */
    const perf = document.querySelector("#perf"); // Performance output

    // Indices for rolling buffers used to smooth jitter
    var idx_t = 0 | 0; // Loop time
    var idx_d = 0 | 0; // Bounding box dimensions
    var last = 4 | 0; // Previous value of idx_d

    // Detector state tracking
    let lostCount = 0 | 0; // Consecutive frames without detection
    let trackExpired = true; // Red bounding box
    let trackStale = true; // Purple bounding box
    var status = 0 | 0; // Passed to C3Mission

    // Previous centroid of bounding box
    let lastX = 0.0;
    let lastY = 0.0;

    // Heuristics thresholds
    const regainMax = 20.0; // max inter-frame jump when track expired
    const trackMax = 50.0; // max inter-frame jump in active or stale track
    const maxsize = 20000.0; // max size on screen
    const minsize = 20.0; // min size on screen
    const close = 1000.0 // size on screen before confidence threshold is raised
    const bigConf = .5 // min confidence for up-close detections
    const maxsquat = 2.9; // max W/H
    const closesquat = .7; // min W/H when close

    /**
     * @param {Number} dX 
     * @param {Number} dY 
     * @param {Number} confInst
     * @returns {Boolean}
     */
    const checkHeuristics = function (dX, dY, confInst) { // Run heuristics checking (reject == return True)
        return ((dX > trackMax || dY > trackMax || converted[9] > maxsquat) && !trackExpired)
            || converted[8] > maxsize || converted[8] < minsize || (converted[8] > close && (confInst < bigConf || closesquat > converted[9]));
    }

    // Main loop
    const doInference = async function () {
        if (!pause) { // Skip this if image updates are paused
            const start = performance.now(); // Get time at loop start
            const discardOldThres = 1500.0 / weighted; // Iterations before track considered lost
            const trackLostThres = discardOldThres / 2.0; // Iterations before track considered stale
            let i = 0; // Current detection being considered/processed

            const bitmap = await createImageBitmap(osc); // Get reference to GPU memory holding intermediate canvas
            const img = tf.browser.fromPixels(bitmap); // Create a tensor from the image
            const input = tf.expandDims(img, 0); // Insert dimension to fit input dimension of MobileNet

            /**
             * @type {{TFLite_Detection_PostProcess: tf.Tensor,
             * "TFLite_Detection_PostProcess:1": tf.Tensor,
             * "TFLite_Detection_PostProcess:2": tf.Tensor,
             * "TFLite_Detection_PostProcess:3": tf.Tensor }}
             */
            const output = model.predict(input); // Run inference
            /** 
             * TFLite_Detection_PostProcess: bounding boxes (packed)
               "TFLite_Detection_PostProcess:1": detection class (not used)
               "TFLite_Detection_PostProcess:2": confidence values
               "TFLite_Detection_PostProcess:3": number of detections
             */

            /**
             * @type {Float32Array}
             */
            const pointsOut = await output.TFLite_Detection_PostProcess.data(); // Download bounding boxes
            /**
             * @type {Float32Array}
             */
            const confOut = output['TFLite_Detection_PostProcess:2'].dataSync(); // Download confidences
            const numDetect = output['TFLite_Detection_PostProcess:3'].bufferSync().values[0]; // Download detection count

            // Free tensors
            img.dispose();
            input.dispose();
            output.TFLite_Detection_PostProcess.dispose();
            output['TFLite_Detection_PostProcess:1'].dispose();
            output['TFLite_Detection_PostProcess:2'].dispose();
            output['TFLite_Detection_PostProcess:3'].dispose();

            trackExpired = (lostCount > discardOldThres); // Check if track is expired

            // De-normalize bounding boxes, compute aspect ratios, calculate Δx and Δy from last loop
            reformat(new Float32Array(pointsOut.buffer, pointsOut.byteOffset, 4), lastX, lastY);
            let dX = converted[6];
            let dY = converted[7];
            i = 0;

            // Test until good detection found
            while (checkHeuristics(dX, dY, confOut[i]) && (i + 1) < numDetect) {
                // Pointer arithmetic with TypedArray to avoid memory copies
                reformat(new Float32Array(pointsOut.buffer, pointsOut.byteOffset + (i + 1) * 16, 4), lastX, lastY);
                dX = converted[6];
                dY = converted[7];
                i++;
            }
            if (checkHeuristics(dX, dY, confOut[i])) { // Catch corner case
                i = 0;
                confOut[0] = 0.0; // No valid detections
            }

            // Store centroid for next loop
            lastX = converted[4];
            lastY = converted[5];

            // Filter out all confidences not above .4
            if (confOut[i] > .4) {
                if (trackExpired && (dX > regainMax || dY > regainMax)) {
                    setAll(); // Force no rolling average when reacquiring track after track lost
                } else { // Rolling averages for bounding box dimensions
                    x_accum[idx_d] = converted[0];
                    y_accum[idx_d] = converted[1];
                    w_accum[idx_d] = converted[2];
                    h_accum[idx_d] = converted[3];
                    m1_accum[idx_d] = lastX; // Register-memory move faster than memory-memory copy
                    m2_accum[idx_d] = lastY;
                }
                lostCount = 0; // Reset lost count
                accConf(confOut[i]); // Rolling buffer for confidence
            } else {
                // Converge averages on last-known point when track is lost
                x_accum[idx_d] = x_accum[last];
                y_accum[idx_d] = y_accum[last];
                w_accum[idx_d] = w_accum[last];
                h_accum[idx_d] = h_accum[last];
                m1_accum[idx_d] = m1_accum[last];
                m2_accum[idx_d] = m2_accum[last];
                lostCount++; // Increement lost count
            }
            last = idx_d; // Store previous index
            idx_d = (idx_d + 1) % 5; // Increment index

            trackStale = (lostCount > trackLostThres); // Check if track is stale

            // Determine bounding box color and state number
            if (lostCount === 0) { // Active
                ctx2.strokeStyle = 'green';
                status = 0;
            } else if (!trackStale) { // Intermittent
                ctx2.strokeStyle = 'blue';
                status = 1;
            } else if (!trackExpired) { // Stale
                accConf(confOut[i]);
                ctx2.strokeStyle = 'purple';
                status = 2;
            } else { // Lost
                ctx2.strokeStyle = 'red';
                status = 3;
            }

            // Render output
            dimsAvg(); // Compute rolling averages for box dimensions
            ctx2.clearRect(0, 0, cvs_w, cvs_h); // Clear old image
            ctx2.drawImage(bitmap, 0, 0); // Copy pre-scaled webcam image
            ctx2.beginPath();
            ctx2.rect(avgs[0], avgs[1], avgs[2], avgs[3]); // Draw box
            ctx2.stroke();

            const smoothConf = avgConf(); // Get rolling average of confidence

            // Display confidence and lost count stats
            desc.innerText = confOut[i].toFixed(7) + ", " + smoothConf.toFixed(7) + ", "
                + String(lostCount).padStart(3, '0');

            if (ipcUp) { // Send data to C3Mission if connected
                worker.postMessage([avgs[0], avgs[1], avgs[2], avgs[3], confOut[i], smoothConf, status]);
            }

            const msec = performance.now() - start; // Get loop time
            rolling[idx_t] = msec; // Rolling average of loop time
            weighted = (4 * weighted + msec) / 5; // Weighted average of loop time
            idx_t = (idx_t + 1) % 10; // Increment index
            const total = rolling[0] + rolling[1] + rolling[2] + rolling[3] + rolling[4] +
                rolling[5] + rolling[6] + rolling[7] + rolling[8] + rolling[9]; // Non-weighted average time
            perf.innerText = msec.toFixed(2).padStart(6, '0') + "ms, " +
                weighted.toFixed(2).padStart(6, '0') + "ms, " + (total / 10).toFixed(2).padStart(6, '0') +
                "ms, rej " + i.toString(); // Print timing statistics
        }
        setTimeout(() => doInference().catch(onError), 5); //Schedule next loop
    }

    // Start the loop
    const runner = doInference();
    runner.catch(onError);
};

// main() called by script in HTML file
const main = () => { init().catch(onError); }