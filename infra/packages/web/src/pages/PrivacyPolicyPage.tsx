import { Link } from "react-router-dom";
import { InfraBrand } from "../components/InfraBrand";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export default function PrivacyPolicyPage() {
  useDocumentTitle("Privacy Policy | Infra");

  return (
    <div className="legal-page">
      <article className="legal-card">
        <header className="legal-header">
          <Link to="https://infrastack.app" className="legal-brand-link">
            <InfraBrand showStack size={36} />
          </Link>
          <p className="legal-kicker">Legal</p>
          <h1>Privacy Policy</h1>
          <p className="muted legal-updated">Last updated: 29 August 2026</p>
        </header>

        <p>
          This Privacy Policy explains how Infra (“Infra”, “we”, “us”) collects, uses, stores and
          shares information when you use our websites, company portal, admin tools and related
          services at{" "}
          <a href="https://infrastack.app">https://infrastack.app</a> and{" "}
          <a href="https://app.infrastack.app">https://app.infrastack.app</a> (together, the
          “Service”).
        </p>
        <p>
          Infra provides business AI and integration services. We help organisations connect
          authorised business systems, search company knowledge, and use AI tools through a
          controlled gateway. This document is a general description of our privacy practices for
          a UK SaaS platform. It is not legal advice, and it does not mean that every
          controller/processor relationship has been independently legally reviewed.
        </p>

        <h2>1. Who we are</h2>
        <p>
          Infra is operated from the United Kingdom. For privacy requests, contact{" "}
          <a href="mailto:admin@infrastack.app">admin@infrastack.app</a>.
        </p>
        <p>
          Depending on the data and the relationship:
        </p>
        <ul>
          <li>
            Infra is typically the <strong>controller</strong> of account, billing, security and
            platform administration data that we need to operate the Service.
          </li>
          <li>
            Where a customer authorises Infra to access that customer’s business systems, Infra
            typically processes that customer content as a <strong>processor</strong> on the
            customer’s instructions.
          </li>
        </ul>
        <p>
          The customer organisation usually decides which users, companies, connectors and
          permissions apply.
        </p>

        <h2>2. Information we collect</h2>
        <p>We collect information in the following categories, only where relevant to the Service.</p>

        <h3>Account information</h3>
        <p>
          Name, email address, mobile number, authentication credentials, role, company membership
          and similar profile details that you or your administrator provide.
        </p>

        <h3>Connected business-system data</h3>
        <p>
          Where a company authorises a connection, we may process data from that system in order
          to provide the Service. This can include:
        </p>
        <ul>
          <li>Microsoft 365, OneDrive, SharePoint and email data</li>
          <li>Google Drive data, where connected</li>
          <li>
            Finance and business systems such as Xero, and future CRM or job-management connectors
          </li>
        </ul>
        <p>
          We do not use connected-system data beyond the access a company has authorised and the
          permissions of the user or service making the request.
        </p>

        <h3>WhatsApp</h3>
        <p>
          If WhatsApp is used with Infra, we process the message content and the sender’s mobile
          number so we can identify the user, apply company permissions, generate a reply where
          enabled, and keep an audit record of the interaction.
        </p>

        <h3>AI / MCP interactions</h3>
        <p>
          We process prompts, tool calls, answers, conversation history and related metadata so we
          can provide the AI gateway, apply permissions, keep a record of interactions, and
          support quality, billing and security review.
        </p>

        <h3>Usage, diagnostic, audit and security logs</h3>
        <p>
          We record operational events such as sign-in activity, connector use, tool execution,
          errors, latency, IP and device/browser information where provided by the client, and
          similar diagnostic or security logs.
        </p>

        <h3>Billing and payment metadata</h3>
        <p>
          We process billing account details, usage quantities, invoices and payment status.
          Payment card data is handled by third-party payment processors such as Stripe. Infra
          does not store full card numbers.
        </p>

        <h3>OCR and document processing</h3>
        <p>
          Where a company uses document or OCR features, document images or files may be sent to
          authorised service providers solely to extract text and make that content available in
          the Service.
        </p>

        <h2>3. How we use information</h2>
        <p>We use personal and company data only to:</p>
        <ul>
          <li>provide, operate and support the Infra Service</li>
          <li>authenticate users and enforce company permissions</li>
          <li>connect to authorised business systems and return results to authorised users</li>
          <li>secure, monitor, troubleshoot and improve the Service</li>
          <li>meter usage, bill customers and prevent abuse</li>
          <li>meet our legal, accounting and security obligations</li>
        </ul>
        <p>
          We do not sell customer data. We do not use customer business content to train public
          foundation models for unrelated third parties.
        </p>

        <h2>4. Legal bases (UK GDPR)</h2>
        <p>Where UK GDPR applies, we typically rely on one or more of the following:</p>
        <ul>
          <li>
            <strong>Contract</strong> — to provide the Service to a customer or user.
          </li>
          <li>
            <strong>Legitimate interests</strong> — to secure, monitor and improve the Service,
            prevent abuse, and keep necessary audit records, balanced against your rights.
          </li>
          <li>
            <strong>Legal obligation</strong> — where we must keep records for tax, accounting or
            similar duties.
          </li>
          <li>
            <strong>Consent</strong> — only where we specifically ask for it and UK law requires
            it.
          </li>
        </ul>
        <p>
          Customer organisations are responsible for making sure they have a lawful basis to
          submit personal data from their own systems into Infra.
        </p>

        <h2>5. Tenant and company isolation</h2>
        <p>
          Infra is a multi-tenant platform. Company data is isolated by company tenancy and access
          controls. Users only see companies they belong to. Connected-system data is requested
          in the context of the authorised company and the user’s permissions. We do not use one
          customer’s business content to answer another customer’s requests.
        </p>

        <h2>6. Sharing and subprocessors</h2>
        <p>
          We share information only as needed to operate the Service, including with authorised
          subprocessors and cloud providers such as:
        </p>
        <ul>
          <li>hosting, compute, storage and related cloud infrastructure providers</li>
          <li>payment processors such as Stripe</li>
          <li>email or transactional message providers, where used</li>
          <li>OCR / document-intelligence providers, where a company uses those features</li>
          <li>AI model providers, where a request is routed through the Infra gateway</li>
          <li>connected-system providers that the customer has authorised (for example Microsoft, Google, Xero, Meta/WhatsApp)</li>
        </ul>
        <p>
          We may also disclose information if required by law, to protect the Service or users, or
          in connection with a business transfer, subject to appropriate safeguards.
        </p>

        <h2>7. International transfers</h2>
        <p>
          Some providers may process data outside the United Kingdom. Where that happens, we use
          appropriate transfer mechanisms recognised under UK data protection law, such as the
          UK addendum to standard contractual clauses or other approved safeguards, as applicable
          to that provider.
        </p>

        <h2>8. Retention and deletion</h2>
        <p>
          We keep information for as long as needed to provide the Service, meet billing and audit
          needs, resolve disputes and comply with law. Account and company data is generally
          retained while the account is active and for a reasonable period afterwards.
        </p>
        <p>
          A company administrator may request deletion of company data. We will delete or
          irreversibly de-identify that data from live systems within a reasonable period, except
          where we must retain a limited copy for legal, security, billing or backup purposes.
          Backups are overwritten on a rolling schedule.
        </p>

        <h2>9. Your rights</h2>
        <p>
          If you are in the UK or EEA, you may have the right to request access, correction,
          erasure, restriction, objection, or portability of personal data we hold about you, and
          to withdraw consent where processing is based on consent.
        </p>
        <p>
          Company users should usually start with their own administrator, because Infra may be
          processing data on that company’s instructions. You can also contact{" "}
          <a href="mailto:admin@infrastack.app">admin@infrastack.app</a>. We may need to verify
          your identity and the relevant company context before we can act.
        </p>
        <p>
          You may complain to the UK Information Commissioner’s Office (
          <a href="https://ico.org.uk">ico.org.uk</a>) if you are unhappy with how we handle your
          data.
        </p>

        <h2>10. Security</h2>
        <p>
          We use technical and organisational measures appropriate to a business SaaS platform,
          including access controls, tenant isolation, encryption in transit, credential
          protection, logging and least-privilege permissions. No internet service can guarantee
          absolute security. You and your organisation remain responsible for protecting
          passwords, device access and the permissions you grant to connectors.
        </p>

        <h2>11. Children</h2>
        <p>
          Infra is a business service. It is not directed at children, and we do not knowingly
          collect personal data from children.
        </p>

        <h2>12. Changes</h2>
        <p>
          We may update this Privacy Policy from time to time. The “Last updated” date at the top
          will change when we do. Continued use of the Service after an update means the revised
          policy applies to that later use.
        </p>

        <h2>13. Contact</h2>
        <p>
          Privacy requests: <a href="mailto:admin@infrastack.app">admin@infrastack.app</a>
          <br />
          Website: <a href="https://infrastack.app">https://infrastack.app</a>
        </p>

        <p className="muted legal-note">
          This page describes Infra’s current privacy practices. It is not legal advice and does
          not create rights beyond those that apply under contract or applicable law.
        </p>
      </article>
    </div>
  );
}
