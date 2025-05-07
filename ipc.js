const net = require('net');
let lock = true;
let up = false;

/**
 * @type {net.Socket}
 */
let client = null;

const onError = function () {
    client.removeAllListeners();
    // client.end();
    client.destroy();
    client = null;
    setTimeout(main, 500);
}

/**
 * @param {MessageEvent<Number[][]>} msg
 */
onmessage = msg => {
    if (up) {
        client.write(JSON.stringify(msg.data));
    }
};

function main() {
    lock = false;

    client = net.createConnection(1337, "127.0.0.1", () => {
        up = true;
        postMessage("connected");
    });

    client.on('close', () => {
        if (!lock) {
            lock = true;
            postMessage("Socket closed \"gracefully\"");
            onError();
        }
    });

    client.on('error', err => {
        if (!lock) {
            lock = true;
            postMessage(err);
            onError();
        }
    });
}

main();