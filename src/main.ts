import "./style.css";
import { start, stop } from "./ui";

addEventListener("pagehide", stop);

// The download link saves the page as served: one self-contained HTML file.
// Opened from disk it is already a local copy, so hide the link there.
if (location.protocol === "file:") document.getElementById("save")?.parentElement?.remove();
void start();
