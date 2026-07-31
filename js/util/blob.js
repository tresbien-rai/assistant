/**
 * Blob helpers (F-04).
 *
 * `blobToBase64` was living in js/views/personas.js because the .tessera
 * exporter was its first caller. When the composer needed it too, that produced
 * the refactor's first import cycle — chats -> composer -> personas -> chats —
 * so it moved to where a shared leaf belongs.
 *
 * `downloadBlob` made the same journey for the same reason (AP-06): the preset
 * exporter is its second caller.
 */

/**
 * Trigger a browser download for a blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // Remove data URL prefix (e.g., "data:image/png;base64,")
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
