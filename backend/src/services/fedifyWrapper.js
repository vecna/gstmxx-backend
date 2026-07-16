/**
 * Helper wrapper to handle native ESM dynamic imports of Fedify in CommonJS.
 * This wrapper simplifies unit testing and mocking.
 */

/**
 * Dynamically imports and returns the Fedify module.
 * 
 * @returns {Promise<Object>} The imported Fedify module.
 */
async function getFedify() {
   return await import('@fedify/fedify');
}

module.exports = {
   getFedify
};
