import { EL_TENANT } from "./mock-data";
import { PageHeader, SectionCard } from "../components";

export default function PortalSettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Company profile and preferences." />

      <div className="grid grid-2">
        <SectionCard title="Company profile">
          <table className="table compact">
            <tbody>
              <tr>
                <td>Company name</td>
                <td>{EL_TENANT.company.name}</td>
              </tr>
              <tr>
                <td>Domain</td>
                <td>{EL_TENANT.company.domain}</td>
              </tr>
              <tr>
                <td>Status</td>
                <td>{EL_TENANT.company.status}</td>
              </tr>
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="White-labelling (future)">
          <p className="muted">
            Company logo, brand colours, and custom domain (e.g. ai.el.example) — not in v0.1.
          </p>
        </SectionCard>
      </div>
    </>
  );
}
