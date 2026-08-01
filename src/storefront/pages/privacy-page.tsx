import { useTranslation } from 'react-i18next'

import { StoreFooter } from '../components/store-footer'
import { StoreHeader } from '../components/store-header'
import { useStorefront } from '../use-storefront'

/**
 * The privacy notice, on the store's own domain.
 *
 * Server-rendered like the rest of the storefront, and in the store's locale —
 * a notice a buyer cannot read is not a notice. The Data Privacy Act requires
 * the data subject be *informed*, which is a higher bar than the document
 * existing somewhere: it has to say who holds the data, what for, how long, who
 * else sees it, and what the person can do about it. Those are the five sections
 * below, in that order, because that is the order the questions occur to
 * somebody who is about to type their address into a form.
 *
 * Deliberately plain. Every hedge and every "may include" makes it less likely
 * to be read, and an unread notice fails the requirement it was written for.
 *
 * `policyVersion` is stamped onto every consent row, so a grant recorded on the
 * 3rd can be traced to the words that were on this page on the 3rd. Changing the
 * text without changing the version is the one thing that breaks that link.
 */
export function PrivacyPage({ policyVersion }: { policyVersion: string }) {
  const { t } = useTranslation()
  const { store } = useStorefront()
  const seller = store?.name ?? ''

  // Written out rather than built from a loop over template-literal keys: those
  // compile and lose the compile-time check that the string exists, which is how
  // a section silently renders its own key name. See CLAUDE.md.
  const sections: { key: string; title: string; body: string }[] = [
    { key: 'who', title: t('privacyPolicy.who'), body: t('privacyPolicy.whoBody', { seller }) },
    { key: 'what', title: t('privacyPolicy.what'), body: t('privacyPolicy.whatBody') },
    { key: 'why', title: t('privacyPolicy.why'), body: t('privacyPolicy.whyBody') },
    { key: 'shared', title: t('privacyPolicy.shared'), body: t('privacyPolicy.sharedBody') },
    { key: 'kept', title: t('privacyPolicy.kept'), body: t('privacyPolicy.keptBody') },
    {
      key: 'rights',
      title: t('privacyPolicy.rights'),
      body: t('privacyPolicy.rightsBody', { seller }),
    },
  ]

  return (
    <>
      <StoreHeader showSearch={false} />
      <main className="mx-auto w-full max-w-2xl px-4 pb-16">
        <h1 className="mt-6 text-xl font-semibold tracking-tight">{t('privacyPolicy.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('privacyPolicy.version', { version: policyVersion })}
        </p>

        <div className="mt-6 space-y-6">
          {sections.map((section) => (
            <section key={section.key}>
              <h2 className="text-base font-medium">{section.title}</h2>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {section.body}
              </p>
            </section>
          ))}
        </div>
      </main>
      <StoreFooter />
    </>
  )
}
