import ScrollReveal from './ScrollReveal';
import {
  CatalogFeatureMockup,
  DashboardFeatureMockup,
  RestockFeatureMockup,
  VendorFeatureMockup,
} from './FeatureMockups';

const FEATURES = [
  {
    id: 'dashboard',
    eyebrow: 'Dashboard',
    headline: 'One screen for the health of your whole business',
    description:
      'See orders, revenue, and net profit — after COGS, ads, and coupons — alongside AOV, low-stock alerts, and MTD revenue. Daily order and revenue trend charts show whether you are gaining or losing ground.',
    bullets: [
      'Orders, revenue, net profit, and AOV at a glance',
      'Low-stock alerts before you run out',
      'MTD revenue with daily trend charts',
    ],
    Mockup: DashboardFeatureMockup,
    imageLeft: false,
  },
  {
    id: 'restock',
    eyebrow: 'Restock Planner',
    headline: 'Know what to reorder before you run out',
    description:
      'Velocity-based reorder recommendations with days-of-cover tracking and stock history. Lead-time aware — factors in supplier lead times so you order early enough, not just often enough.',
    bullets: [
      'Days-of-cover with color-coded urgency',
      'Recommended order qty per SKU',
      'Lead-time aware reorder timing',
    ],
    Mockup: RestockFeatureMockup,
    imageLeft: true,
  },
  {
    id: 'catalog',
    eyebrow: 'SKU Catalog & Mappings',
    headline: 'Every SKU mapped, every mismatch caught',
    description:
      'Manage inventory SKUs, combo/bundle products, and storefront-to-Teapplix SKU mappings in one place. Unmapped SKUs and mapping errors surface automatically — no spreadsheet archaeology.',
    bullets: [
      'Single SKUs and bundle/combo products',
      'Storefront-to-Teapplix mapping table',
      'Auto-detect unmapped SKUs and errors',
    ],
    Mockup: CatalogFeatureMockup,
    imageLeft: false,
  },
  {
    id: 'vendor',
    eyebrow: 'Vendor Central Analytics',
    headline: 'ASIN-level visibility into vendor performance',
    description:
      'Product-line analytics with vendor-side KPIs and margin/discrepancy tracking at the ASIN level. See which products drive revenue and which ones are bleeding margin.',
    bullets: [
      'ASIN-level revenue and margin tracking',
      'Discrepancy counts per product line',
      'Vendor-side KPI rollups',
    ],
    Mockup: VendorFeatureMockup,
    imageLeft: true,
  },
] as const;

export default function FeatureShowcase() {
  return (
    <section id="features" className="relative scroll-mt-20">
      <div className="max-w-7xl mx-auto px-6 py-28 lg:py-40">
        <ScrollReveal className="text-center max-w-2xl mx-auto mb-20 lg:mb-28">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent-primary mb-3">
            Features
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-text-primary tracking-tight">
            Built for Amazon and Teapplix operators
          </h2>
          <p className="mt-4 text-text-secondary leading-relaxed">
            Four tools that replace the spreadsheets, manual checks, and channel-hopping you do today.
          </p>
        </ScrollReveal>

        <div className="space-y-28 lg:space-y-40">
          {FEATURES.map((feature, index) => {
            const { Mockup } = feature;
            const textBlock = (
              <div className="space-y-5">
                <p className="text-xs font-semibold uppercase tracking-widest text-accent-primary">
                  {feature.eyebrow}
                </p>
                <h3 className="text-2xl sm:text-3xl font-bold text-text-primary tracking-tight leading-tight">
                  {feature.headline}
                </h3>
                <p className="text-text-secondary leading-relaxed">{feature.description}</p>
                <ul className="space-y-2.5">
                  {feature.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-start gap-2.5 text-sm text-text-secondary">
                      <span className="mt-1.5 w-1 h-1 rounded-full bg-accent-primary shrink-0" />
                      {bullet}
                    </li>
                  ))}
                </ul>
              </div>
            );

            const mockupBlock = (
              <div className="w-full">
                <Mockup />
              </div>
            );

            return (
              <ScrollReveal key={feature.id} delay={index * 50}>
                <div
                  className={[
                    'grid lg:grid-cols-2 gap-10 lg:gap-16 items-center',
                    feature.imageLeft ? '' : '',
                  ].join(' ')}
                >
                  {feature.imageLeft ? (
                    <>
                      <div className="order-1 lg:order-1">{mockupBlock}</div>
                      <div className="order-2 lg:order-2">{textBlock}</div>
                    </>
                  ) : (
                    <>
                      <div className="order-2 lg:order-1">{textBlock}</div>
                      <div className="order-1 lg:order-2">{mockupBlock}</div>
                    </>
                  )}
                </div>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
