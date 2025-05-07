const fs = require('fs');
const http = require('http');
const path = require('path');
const { ipcRenderer } = require('electron/renderer');

/**
 * @callback stdMath
 * @param {Number} x
 * @return {Number}
 */

exports.asmExport = (() => {
    /**
     * @param {{Math: {abs: stdMath}, Float64Array: Float64ArrayConstructor}} stdlib
     * @param {null} foreign
     * @param {ArrayBuffer} heap
     */
    const asmBuilder = function (stdlib, foreign, heap) { // Function signature must look like this for asm.js
        "use asm"; // Special sauce
    
        const abs = stdlib.Math.abs; // Math functions are statically-linked
        const work = new stdlib.Float64Array(heap); // Shared memory with non-asm.js code
        
        // Declare as float64
        var mX = 0.0;
        var mY = 0.0;
        var w = 0.0;
        var h = 0.0;

        // Declare as integer
        var idx = 0;

        /**
         * @param {Number} a 
         * @param {Number} b
         * @param {Number} c
         * @param {Number} d
         * @param {Number} lastX
         * @param {Number} lastY
         */
        function reformat(a, b, c, d, lastX, lastY) {
            // Declare parameters as doubles
            a = +a; // box_raw[0], y1
            b = +b; // box_raw[1], x1
            c = +c; // box_raw[2], y2
            d = +d; // box_raw[3], x2
            lastX = +lastX;
            lastY = +lastY;

            // Find centroid
            mX = ((d + b) / 2.0) * 300.0;
            mY = ((a + c) / 2.0) * 300.0;

            // Find width and height
            w = 300.0 * (d - b);
            h = 300.0 * (c - a);

            // Write to shared memory
            work[0] = 300.0 * b; // Denormalize to 300x300
            work[1] = 300.0 * a; // Denormalize to 300x300
            work[2] = w;
            work[3] = h;
            work[4] = mX; // centroid's x
            work[5] = mY; // centroid's y
            work[6] = +abs(mX - lastX); // Δx from last frame
            work[7] = +abs(mY - lastY); // Δy from last frame
            work[8] = w * h;
            work[9] = w / h;
        }

        function dimsAvg() { // Computes rolling averages of box x,y,w,h
            work[40] = (+work[10] + +work[11] + +work[12] + +work[13] + +work[14]) / 5.0;
            work[41] = (+work[15] + +work[16] + +work[17] + +work[18] + +work[19]) / 5.0;
            work[42] = (+work[20] + +work[21] + +work[22] + +work[23] + +work[24]) / 5.0;
            work[43] = (+work[25] + +work[26] + +work[27] + +work[28] + +work[29]) / 5.0;
        }

        function setAll() { // Overrides rolling averages
            // x1
            work[10] = +work[0];
            work[11] = +work[0];
            work[12] = +work[0];
            work[13] = +work[0];
            work[14] = +work[0];

            // y1
            work[15] = +work[1];
            work[16] = +work[1];
            work[17] = +work[1];
            work[18] = +work[1];
            work[19] = +work[1];

            // w
            work[20] = +work[2];
            work[21] = +work[2];
            work[22] = +work[2];
            work[23] = +work[2];
            work[24] = +work[2];

            // h
            work[25] = +work[3];
            work[26] = +work[3];
            work[27] = +work[3];
            work[28] = +work[3];
            work[29] = +work[3];

            // centroid's x
            work[30] = +work[4];
            work[31] = +work[4];
            work[32] = +work[4];
            work[33] = +work[4];
            work[34] = +work[4];

            // centroid's y
            work[35] = +work[5];
            work[36] = +work[5];
            work[37] = +work[5];
            work[38] = +work[5];
            work[39] = +work[5];
        }

        /**
         * @param {Number} conf 
         */
        function accConf(conf) { // Rolling average accumulator for confidence
            conf = +conf; // Declare parameter as double
            work[((idx + 46) << 3) >> 3] = conf; // Read and understand the line below before modifying
            // Yes, I know the shifts cancel each other out. They're needed for asm.js array addressing.
            idx = (idx + 1) | 0;
            idx = ((idx | 0) % 5) | 0;
        }

        /**
         * @returns {Number}
         */
        function avgConf() { // Returns rolling average for confidence
            return ((+work[46] + +work[47] + +work[48] + +work[49] + +work[50]) / 5.0);
        }

        return { // Export modules from asm.js
            reformat: reformat,
            dimsAvg: dimsAvg,
            setAll: setAll,
            accConf: accConf,
            avgConf: avgConf
        }
    }

    const mem = new ArrayBuffer(0x1000); // Shared memory buffer
    const module = asmBuilder({ Math: { abs: Math.abs }, Float64Array }, null, mem); // Compile and link modules

    return {
        /**
         * @param {Float32Array} box_raw
         * @param {Number} lastX
         * @param {Number} lastY
         */
        reformat: (box_raw, lastX, lastY) => { // asm.js functions can't take arrays as parameters
            module.reformat(box_raw[0], box_raw[1], box_raw[2], box_raw[3], lastX, lastY);
        },

        // Direct exports
        dimsAvg: module.dimsAvg,
        setAll: module.setAll,
        accConf: module.accConf,
        avgConf: module.avgConf,

        // Expose slices of shared memory as typed arrays
        converted: new Float64Array(mem, 0, 10), // 0-9
        x_accum: new Float64Array(mem, 80, 5), // 10-14
        y_accum: new Float64Array(mem, 120, 5), // 15-19
        w_accum: new Float64Array(mem, 160, 5), // 20-24
        h_accum: new Float64Array(mem, 200, 5), // 25-29
        m1_accum: new Float64Array(mem, 240, 5), // 30-34
        m2_accum: new Float64Array(mem, 280, 5), // 35-39
        avgs: new Float64Array(mem, 320, 4) // 40-43
    }
})();

// Server for self-serving TFlite compatibility modules
const MIME_TYPES = { // Files that can be served
    js: "text/javascript",
    wasm: "application/wasm",
    txt: "text/plain"
};
const assets = path.join(process.cwd(), "./node_modules/@tensorflow/tfjs-tflite/wasm"); // Path to modules
const toBool = [() => true, () => false];
const port = Math.round(Math.random() * (10000 - 9000) + 9000); // Randomize TCP port
const prepareFile = async (url) => { // Find and open requested file
    // Expand paths to absolute
    const paths = [assets, url];
    const filePath = path.join(...paths);

    // Check if file exists
    const pathTraversal = !filePath.startsWith(assets);
    const exists = await fs.promises.access(filePath).then(...toBool);
    const found = !pathTraversal && exists;

    // Serve file if found, else server 404 message
    const streamPath = found ? filePath : path.join(process.cwd(), "./404.txt");
    const ext = path.extname(streamPath).substring(1).toLowerCase(); // Get file extension
    const stream = fs.createReadStream(streamPath); // Open file for reading
    return { found, ext, stream };
};
const server = http.createServer(async (req, res) => {
    try {
        if (req.socket.remoteAddress.includes("127.0.0.1")) { // Only respond to localhost
            const file = await prepareFile(req.url); // Attempt to open file
            const statusCode = file.found ? 200 : 404; // Determine HTTP status code
            const mimeType = MIME_TYPES[file.ext]; // Find MIME type from dictionary
            res.writeHead(statusCode, { "Content-Type": mimeType });
            file.stream.pipe(res); // Write file to payload
            console.log(`${req.method} ${req.url} ${statusCode}`);
        } else { // Ignore any requests from not localhost
            console.log("Ignored request from " + req.socket.remoteAddress);
        }
    }
    catch (err) {
        onError(err);
    }
});
exports.server = server;
exports.port = port;

/**
 * @param {Error} error 
 */
exports.onError = function (error) {
    console.error(error); // Write error to DevTools console
    ipcRenderer.send('error'); // Send error to terminal
}