import { PageHeader, SectionCard } from "../components";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Platform configuration. White-labelling deferred to a future release."
      />

      <div className="grid grid-2">
        <SectionCard title="Environment">
          <table className="table compact">
            <tbody>
              <tr>
                <td>Environment</td>
                <td>Development</td>
              </tr>
              <tr>
                <td>Stripe mode</td>
                <td>Test</td>
              </tr>
              <tr>
                <td>Platform</td>
                <td>Cloudflare Workers + D1 + Pages</td>
              </tr>
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Future white-labelling">
          <p className="muted">
            Architecture will support company logo, brand colours, and custom
            domains without separate codebases. Not implemented in v0.1.
          </p>
        </SectionCard>

        <SectionCard title="Security">
          <p className="muted">
            No connection to legacy Nirvana, Aquilo, or Urban Maintenance systems.
            External connections require explicit approval with documented
            permissions before activation.
          </p>
        </SectionCard>
      </div>
    </>
  );
}
