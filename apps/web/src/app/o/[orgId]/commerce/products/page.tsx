import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { money } from '@/components/commerce/document-view';
import { ProductArchiveButton, ProductEditor } from '@/components/commerce/product-editor';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { Product, TaxRate } from '@/lib/commerce-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function ProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('commerce.invoice.read')) {
    return <CrmForbidden title={m.commerce.products} message={m.commerce.forbidden} />;
  }
  const includeArchived = query.archived === 'true';
  const api = `/app/orgs/${orgId}/commerce`;
  const [products, taxRates, me] = await Promise.all([
    serverGetJson<{ data: Product[] }>(
      `${api}/products?includeArchived=${String(includeArchived)}`,
    ),
    serverGetJson<{ data: TaxRate[] }>(`${api}/tax-rates?includeArchived=true`),
    getMe(),
  ]);
  if (!products || !taxRates) notFound();
  const canManage = access.permissions.includes('commerce.catalog.manage');
  const defaultCurrency =
    me?.organizations.find((entry) => entry.id === orgId)?.defaultCurrency ?? 'BHD';

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.commerce.products}
        actions={
          canManage ? (
            <ProductEditor taxRates={taxRates.data} defaultCurrency={defaultCurrency} />
          ) : null
        }
      />
      <div className="mb-4 text-sm">
        <Link
          href={includeArchived ? `/o/${orgId}/commerce/products` : '?archived=true'}
          className="text-brand-600 hover:underline"
        >
          {includeArchived ? m.commerce.products : m.commerce.showArchived}
        </Link>
      </div>
      {products.data.length === 0 ? (
        <EmptyState title={m.commerce.emptyProducts}>{m.commerce.emptyProductsHint}</EmptyState>
      ) : (
        <ul
          className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white"
          data-testid="product-list"
        >
          {products.data.map((product) => (
            <li key={product.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">
                  {product.name}
                  {product.archived ? (
                    <span className="ms-2 text-xs text-slate-500">({m.commerce.archived})</span>
                  ) : null}
                </p>
                <p className="text-xs text-slate-500">
                  {m.commerce.kinds[product.kind]}
                  {product.sku ? ` · ${product.sku}` : ''}
                  {product.taxRate ? ` · ${product.taxRate.name} ${product.taxRate.percent}%` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm tabular-nums text-slate-700">
                  {product.prices.map((price) => money(price.unitAmount)).join(' · ') || '—'}
                </span>
                {canManage ? (
                  <>
                    <ProductEditor
                      product={product}
                      taxRates={taxRates.data}
                      defaultCurrency={defaultCurrency}
                    />
                    <ProductArchiveButton product={product} />
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </OrgAccessBoundary>
  );
}
