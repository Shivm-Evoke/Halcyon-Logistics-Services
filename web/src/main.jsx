import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App.jsx';
import Login from './demo/Login.jsx';
import Portal from './demo/Portal.jsx';
import Ops from './demo/Ops.jsx';
import Track from './demo/Track.jsx';
import './index.css';
import { applyTheme, savedChoice } from './theme.js';

// Charts read PAL while rendering, so set it before the first render.
applyTheme(savedChoice());

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      {/* The three-sided demo has its own screens; every other path is the analysis story, unchanged. */}
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/portal" element={<Portal />} />
        <Route path="/ops" element={<Ops />} />
        <Route path="/track/:token" element={<Track />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
