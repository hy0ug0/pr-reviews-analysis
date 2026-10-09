import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
} from "chart.js";
import App from "./App";
// eslint-disable-next-line import/no-unassigned-import
import "./app.css";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
);
// Match the page font instead of chart.js's Helvetica default.
ChartJS.defaults.font.family = '"Inter", system-ui, -apple-system, sans-serif';

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
