function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function slimInvoice(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    invoiceNumber: value.invoiceNumber ?? value.InvoiceNumber ?? value.invoice_number ?? null,
    invoice_id: value.invoice_id ?? value.InvoiceID ?? value.id ?? null,
    contact: value.contact ?? value.ContactName ?? value.contactName ?? null,
    total: value.total ?? value.Total ?? value.amount ?? null,
    due: value.due ?? value.DueDate ?? value.dueDate ?? null,
    status: value.status ?? value.Status ?? null,
    reference: value.reference ?? value.Reference ?? null,
  };
}

function slimCustomer(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    name: value.name ?? value.contact ?? value.ContactName ?? null,
    total: value.total ?? value.amount ?? value.sales_total ?? null,
  };
}

function slimMessage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    id: value.id ?? value.messageId ?? value.emailId ?? value.email_id ?? value.internetMessageId ?? null,
    subject: value.subject ?? null,
    from: value.from ?? value.sender ?? null,
    receivedDateTime: value.receivedDateTime ?? value.received ?? value.date ?? null,
  };
}

function slimCatalogueDocument(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const description = String(value.description ?? "").slice(0, 200);
  return {
    id: value.id ?? null,
    title: value.title ?? value.name ?? null,
    source: value.source ?? value.source_type ?? null,
    createdAt: value.createdAt ?? value.created_at ?? null,
    modifiedAt: value.modifiedAt ?? value.modified_at ?? value.lastModifiedDateTime ?? null,
    modifiedBy: value.modifiedBy ?? value.lastModifiedBy ?? null,
    fileType: value.fileType ?? value.file_type ?? null,
    url: value.url ?? value.webUrl ?? null,
    description,
    descriptionSource: value.descriptionSource ?? null,
  };
}

function catalogueRecord(value: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(value.documents) && (value.status || value.dateField || value.source || value.code)) {
    return value;
  }
  if (isRecord(value.result) && Array.isArray(value.result.documents)) {
    return value.result;
  }
  return null;
}

/**
 * Keep Xero/Outlook summaries when clipping bulky tool payloads so synthesis
 * can still read totals, invoice lists, and email subjects after truncation.
 */
export function clipBusinessToolData(value: unknown, toolName = ""): unknown {
  if (isRecord(value)) {
    if (toolName === "list_documents" || catalogueRecord(value)) {
      const catalogue = isRecord(value) ? catalogueRecord(value) ?? value : value;
      const documents = Array.isArray(catalogue.documents) ? catalogue.documents : [];
      return {
        status: catalogue.status ?? "ok",
        code: catalogue.code ?? null,
        source: catalogue.source ?? null,
        sort: catalogue.sort ?? null,
        dateField: catalogue.dateField ?? null,
        dateFieldReason: catalogue.dateFieldReason ?? null,
        limit: catalogue.limit ?? documents.length,
        count: catalogue.count ?? documents.length,
        backend: catalogue.backend ?? null,
        message: catalogue.message ?? null,
        documents: documents.slice(0, 12).map(slimCatalogueDocument),
      };
    }
    if (toolName === "outlook_get_message" || ("body" in value && /^outlook_/.test(toolName))) {
      return {
        id: value.id ?? value.messageId ?? value.emailId ?? value.email_id ?? value.internetMessageId ?? null,
        mailboxAddress: value.mailboxAddress ?? value.mailbox ?? null,
        subject: value.subject ?? null,
        from: value.from ?? value.sender ?? null,
        receivedDateTime: value.receivedDateTime ?? value.received ?? value.date ?? null,
        body: String(value.body ?? value.bodyPreview ?? "").slice(0, 1_200),
      };
    }
    if (/^outlook_/.test(toolName) || Array.isArray(value.messages)) {
      const messages = Array.isArray(value.messages) ? value.messages : [];
      return {
        mailboxAddress: value.mailboxAddress ?? value.mailbox ?? null,
        count: value.count ?? messages.length,
        messages: messages.slice(0, 8).map(slimMessage),
      };
    }
    if (toolName === "xero_top_customers" || Array.isArray(value.customers)) {
      const customers = Array.isArray(value.customers) ? value.customers : [];
      return {
        source: value.source ?? "Xero",
        customers: customers.slice(0, 8).map(slimCustomer),
      };
    }
    if (
      toolName === "xero_search_invoices" ||
      toolName === "xero_list_overdue_invoices" ||
      Array.isArray(value.invoices)
    ) {
      const invoices = Array.isArray(value.invoices) ? value.invoices : [];
      return {
        source: value.source ?? "Xero",
        invoice_numbers: value.invoice_numbers ?? null,
        fromDate: value.fromDate ?? null,
        toDate: value.toDate ?? null,
        invoices: invoices.slice(0, 8).map(slimInvoice),
      };
    }
    if (toolName === "xero_get_invoice" || isRecord(value.invoice)) {
      return {
        source: value.source ?? "Xero",
        invoice: slimInvoice(value.invoice ?? value),
      };
    }
    if (/^xero_/.test(toolName) || "sales_total" in value || value.source === "Xero") {
      const summary = isRecord(value.summary) ? value.summary : {};
      return {
        source: value.source ?? "Xero",
        sales_total: value.sales_total ?? summary.totalSales,
        invoice_count: value.invoice_count ?? summary.transactionCount,
        currencyCode: value.currencyCode ?? value.currency,
        period: value.period ?? null,
        summary,
      };
    }
  }
  const raw = JSON.stringify(value ?? null);
  if (raw.length <= 3_500) return value;
  return { preview: raw.slice(0, 3_500), truncated: true };
}
