// The website's three areas: public pages, the customer portal, and the staff operations app.
import { Route, Routes } from 'react-router-dom';
import { SessionProvider, RequireRole } from './components/session.jsx';
import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import PortalLayout from './portal/PortalLayout.jsx';
import App from './App.jsx';

export default function Root() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/portal/*" element={<RequireRole role="customer"><PortalLayout /></RequireRole>} />
        <Route path="*" element={<RequireRole role="staff"><App /></RequireRole>} />
      </Routes>
    </SessionProvider>
  );
}
