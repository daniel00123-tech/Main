import { NavLink, Route, Routes } from "react-router-dom";
import CataloguePage from "./pages/CataloguePage";
import CompaniesPage from "./pages/CompaniesPage";
import CompanyDetailPage from "./pages/CompanyDetailPage";
import DashboardPage from "./pages/DashboardPage";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">INFRA</div>
        <div className="brand-sub">Business AI control plane</div>
        <nav>
          <NavLink className="nav-link" to="/" end>
            Dashboard
          </NavLink>
          <NavLink className="nav-link" to="/companies">
            Companies
          </NavLink>
          <NavLink className="nav-link" to="/connectors">
            Connector Catalogue
          </NavLink>
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/companies" element={<CompaniesPage />} />
        <Route path="/companies/:slug" element={<CompanyDetailPage />} />
        <Route path="/connectors" element={<CataloguePage />} />
      </Routes>
    </Shell>
  );
}
