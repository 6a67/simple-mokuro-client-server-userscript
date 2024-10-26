# Simple Mokuro Client Server Userscript

A very basic userscript to send images from the browser to a local Mokuro server.
The local Mokuro server OCRs the image, caches the result and sends it back to the browser where the text is overlayed on the image.

## Usage 🚀

- Install the script using [this link](https://raw.githubusercontent.com/6a67/simple-mokuro-client-server-userscript/main/script.user.js)
- Run the local server by executing `server.py`
- Pressing `Alt` should show a button in the top right corner of an image. Clicking the button will send the image to the server and display the OCR result.
- The userscript manager's menu should show an options to enable Auto Mode. In this mode, the script will automatically send the largest image on the page to the server and display the OCR result.

## Sources 📚

- https://github.com/kha-white/mokuro