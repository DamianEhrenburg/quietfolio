import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import { brandIcon } from "../shared/brand";
import type { UiLocale } from "../shared/types";
import { enMessages, getMessages, ruMessages } from "../i18n";

interface LanguageWelcomeProps {
  onChoose: (locale: UiLocale) => Promise<void>;
}

const localeOptions = [
  {
    id: "en" as const,
    name: enMessages.language.english
  },
  {
    id: "ru" as const,
    name: ruMessages.language.russian
  }
] as const;

export function LanguageWelcome({ onChoose }: LanguageWelcomeProps) {
  const [selected, setSelected] = useState<UiLocale | null>(null);
  const [saving, setSaving] = useState(false);
  const previewLocale = selected ?? "en";
  const preview = getMessages(previewLocale);

  const confirm = useCallback(async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      await onChoose(selected);
    } finally {
      setSaving(false);
    }
  }, [onChoose, saving, selected]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && selected && !saving) {
        event.preventDefault();
        void confirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirm, saving, selected]);

  return (
    <div className="language-welcome">
      <div className="language-welcome-ambient" aria-hidden="true">
        <span className="language-welcome-orb language-welcome-orb-violet" />
        <span className="language-welcome-orb language-welcome-orb-gold" />
      </div>

      <section
        className="language-welcome-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="language-welcome-title"
        aria-busy={saving}
      >
        <header className="language-welcome-top minimal">
          <div className="language-welcome-intro" key={`intro-${previewLocale}`}>
            <div className="language-welcome-brand">
              <span className="language-welcome-mark">
                <img className="language-welcome-mark-icon" src={brandIcon} width={46} height={46} alt="" draggable={false} />
              </span>
              <div>
                <strong>Quietfolio</strong>
                <span>{preview.brand.tagline}</span>
              </div>
            </div>
            <span className="eyebrow">{preview.language.welcomeEyebrow}</span>
            <h1 id="language-welcome-title">{preview.language.welcomeTitle}</h1>
          </div>
        </header>

        <div className="language-locale-grid" role="listbox" aria-label={preview.language.interface}>
          {localeOptions.map((option) => {
            const isSelected = selected === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={saving}
                className={isSelected ? "language-locale-tile selected" : "language-locale-tile"}
                onClick={() => setSelected(option.id)}
              >
                <div className="language-locale-copy">
                  <strong>{option.name}</strong>
                </div>
                <span className="language-locale-check" aria-hidden="true">
                  {isSelected ? <Check size={18} /> : null}
                </span>
              </button>
            );
          })}
        </div>

        <footer className="language-welcome-footer">
          <button
            type="button"
            className="primary-action large language-welcome-continue"
            disabled={!selected || saving}
            onClick={() => void confirm()}
          >
            {saving ? (
              <>
                <LoaderCircle className="spin-icon" size={18} />
                {preview.language.saving}
              </>
            ) : (
              <>
                {preview.language.continue}
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}
