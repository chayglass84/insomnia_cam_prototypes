import { Button } from 'react-aria-components';

import bgUrl from './bg.png';

interface KonnectSyncIntroProps {
  onConfigure: () => void;
}

export const KonnectSyncIntro = ({ onConfigure }: KonnectSyncIntroProps) => {
  return (
    <div className="m-2 flex flex-col overflow-hidden rounded-md bg-black text-center text-white">
      <img src={bgUrl} alt="" className="w-full object-cover" />
      <div className="flex flex-col items-center gap-5 px-4 pb-10">
        <span className="rounded-sm border border-[#b5f021] px-2 py-0.5 text-xs font-semibold text-[#b5f021]">NEW</span>
        <div className="flex flex-col gap-3">
          <h3 className="text-base leading-snug font-bold">Bring your Kong gateways into Insomnia</h3>
          <div className="flex flex-col gap-2 text-sm text-[#aaa]">
            <p>
              <strong className="text-white">AI Gateway:</strong> debug your routes and models, test prompts and skills
              across models, and compare results, tokens and cost.
            </p>
            <p>
              <strong className="text-white">API Gateway:</strong> auto-sync your control plane routes and test your
              gateway configuration.
            </p>
          </div>
        </div>
        <Button
          onPress={onConfigure}
          className="flex h-full items-center justify-center gap-2 rounded-md border border-solid border-white/40 px-4 py-2 text-sm text-white transition-colors hover:bg-white/10 aria-pressed:bg-white/10"
        >
          Configure
        </Button>
      </div>
    </div>
  );
};
