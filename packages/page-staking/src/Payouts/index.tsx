// Copyright 2017-2025 @polkadot/app-staking authors & contributors
// SPDX-License-Identifier: Apache-2.0

import type { DeriveStakerReward } from '@polkadot/api-derive/types';
import type { OwnPool } from '@polkadot/app-staking2/Pools/types';
import type { StakerState } from '@polkadot/react-hooks/types';
import type { Balance } from '@polkadot/types/interfaces';
import type { PayoutStash, PayoutValidator } from './types.js';

import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button, MarkWarning, styled, Table, ToggleGroup } from '@polkadot/react-components';
import { useApi, useBlockInterval, useCall, useOwnEraRewards } from '@polkadot/react-hooks';
import { BN, BN_THREE } from '@polkadot/util';

import ElectionBanner from '../ElectionBanner.js';
import { useTranslation } from '../translate.js';
import PayButton from './PayButton.js';
import Stash from './Stash.js';
import Validator from './Validator.js';

interface Props {
  className?: string;
  historyDepth?: BN;
  isInElection?: boolean;
  ownPools?: OwnPool[];
  ownValidators: StakerState[];
}

interface Available {
  stashAvail?: BN | null;
  stashes?: PayoutStash[];
  valAvail?: BN | null;
  valTotal?: BN | null;
  validators?: PayoutValidator[];
}

interface EraSelection {
  value: number;
  text: string;
}

const DAY_SECS = new BN(1000 * 60 * 60 * 24);

function supportsPagedRewards (api: any): boolean {
  const s = api?.query?.staking ?? {};

  return !!s.claimedRewards && typeof s.claimedRewards.multi === 'function' &&
      !!s.erasStakersOverview && typeof s.erasStakersOverview.multi === 'function';
}

async function preloadLegacyClaims (api: any, targets: string[]): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();

  if (!targets.length) {
    return out;
  }

  const ledgers = await api.query.staking.ledger.multi(targets);

  targets.forEach((t: string, i: number) => {
    const ledger = (ledgers[i])?.toJSON?.() ?? {};
    const legacyList: number[] = (ledger.legacyClaimedRewards ?? ledger.claimedRewards ?? []) as number[];

    out.set(t, new Set(legacyList));
  });

  return out;
}

async function normalizeRewardsClaims (
  api: any,
  source: Record<string, DeriveStakerReward[]>
): Promise<Record<string, DeriveStakerReward[]>> {
  if (!source || !Object.keys(source).length) {
    return source;
  }

  const paged = supportsPagedRewards(api);
  const keyPairs: [number, string][] = [];
  const validatorsSet = new Set<string>();

  for (const rewards of Object.values(source)) {
    for (const r of rewards) {
      for (const [validatorId] of Object.entries((r as any).validators ?? {})) {
        validatorsSet.add(validatorId);
        keyPairs.push([Number((r as any).era), validatorId]);
      }
    }
  }

  const validators = Array.from(validatorsSet);

  if (!validators.length || !keyPairs.length) {
    return source;
  }

  const legacyByTarget = await preloadLegacyClaims(api, validators);

  let claimedResp: any[] = [];
  let overviewResp: any[] = [];

  if (paged) {
    [claimedResp, overviewResp] = await Promise.all([
      api.query.staking.claimedRewards.multi(keyPairs),
      api.query.staking.erasStakersOverview.multi(keyPairs)
    ]);
  }

  const claimedMap = new Map<string, number[]>();
  const overviewMap = new Map<string, any>();

  if (paged) {
    keyPairs.forEach(([era, v], idx) => {
      const k = `${era}-${v}`;

      claimedMap.set(k, ((claimedResp[idx])?.toJSON?.() ?? []) as number[]);
      overviewMap.set(k, overviewResp[idx]);
    });
  }

  const out: Record<string, DeriveStakerReward[]> = {};

  for (const [stashId, rewards] of Object.entries(source)) {
    out[stashId] = rewards.map((r) => {
      const era = Number((r as any).era);
      const claimedByValidator: Record<string, boolean> = {};
      let allValidatorsClaimed = true;

      for (const [validatorId] of Object.entries((r as any).validators ?? {})) {
        const legacy = legacyByTarget.get(validatorId);
        let fullyClaimed = false;

        if (paged) {
          const k = `${era}-${validatorId}`;
          const pages: number[] = claimedMap.get(k) ?? [];
          const ov: any = overviewMap.get(k);

          if (ov?.isSome) {
            const pageCount = ov.unwrap().pageCount.toNumber();
            const needed = Math.max(pageCount, 1);

            fullyClaimed = pages.length >= needed;
          } else {
            fullyClaimed = pages.length > 0 || !!legacy?.has(era);
          }
        } else {
          fullyClaimed = !!legacy?.has(era);
        }

        claimedByValidator[validatorId] = fullyClaimed;

        if (!fullyClaimed) {
          allValidatorsClaimed = false;
        }
      }

      return {
        ...r,
        isClaimed: allValidatorsClaimed,
        claimedByValidator
      } as any;
    });
  }

  return out;
}

function groupByValidator (allRewards: Record<string, DeriveStakerReward[]>): PayoutValidator[] {
  return Object
    .entries(allRewards)
    .reduce((grouped: PayoutValidator[], [stashId, rewards]): PayoutValidator[] => {
      rewards.forEach((reward: any): void => {
        const { claimedByValidator = {}, era, validators = {} } = reward;

        Object.entries(validators as Record<string, {total: Balance, value: Balance}>).forEach(([validatorId, { total, value }]): void => {
          const perValClaimed = claimedByValidator[validatorId] ?? reward.isClaimed ?? false;
          const entry = grouped.find((e) => e.validatorId === validatorId);
          const addVal = perValClaimed ? new BN(0) : value;

          if (entry) {
            const eraEntry = entry.eras.find((e) => e.era.eq(era));

            if (eraEntry) {
              eraEntry.stashes[stashId] = value;
              eraEntry.isClaimed = perValClaimed;
            } else {
              entry.eras.push({
                era,
                isClaimed: perValClaimed,
                stashes: { [stashId]: value }
              });
            }

            entry.available = entry.available.add(addVal);
            entry.total = entry.total.add(total);
          } else {
            grouped.push({
              available: addVal,
              eras: [{
                era,
                isClaimed: perValClaimed,
                stashes: { [stashId]: value }
              }],
              total,
              validatorId
            });
          }
        });
      });

      return grouped;
    }, [])
    .sort((a, b) => b.available.cmp(a.available));
}

function extractStashes (allRewards: Record<string, DeriveStakerReward[]>): PayoutStash[] {
  return Object
    .entries(allRewards)
    .map(([stashId, rewards]): PayoutStash => {
      let available = new BN(0);

      rewards.forEach((r: any) => {
        const { claimedByValidator = {}, validators = {} } = r;

        Object.entries(validators as Record<string, {value: Balance}>).forEach(([validatorId, { value }]) => {
          const perValClaimed = claimedByValidator[validatorId] ?? r.isClaimed ?? false;

          if (!perValClaimed) {
            available = available.iadd(value);
          }
        });
      });

      return { available, rewards, stashId };
    })
    .filter(({ available }) => !available.isZero())
    .filter(({ rewards }) =>
      rewards.some((r: any) => {
        const { claimedByValidator = {}, validators = {} } = r;

        return Object.keys(validators).some((vId) => !(claimedByValidator[vId] ?? r.isClaimed ?? false));
      })
    )
    .sort((a, b) => b.available.cmp(a.available));
}

function getAvailable (allRewards: Record<string, DeriveStakerReward[]> | null | undefined): Available {
  if (allRewards) {
    const stashes = extractStashes(allRewards);
    const validators = groupByValidator(allRewards);
    const stashAvail = stashes.length
      ? stashes.reduce<BN>((a, { available }) => a.iadd(available), new BN(0))
      : null;
    const [valAvail, valTotal] = validators.length
      ? validators.reduce<[BN, BN]>(([a, t], { available, total }) => [a.iadd(available), t.iadd(total)], [new BN(0), new BN(0)])
      : [null, null];

    return {
      stashAvail,
      stashes,
      valAvail,
      valTotal,
      validators
    };
  }

  return {};
}

function getOptions (blockTime: BN, eraLength: BN | undefined, historyDepth: BN | undefined, t: (key: string, options?: { replace: Record<string, unknown> }) => string): EraSelection[] {
  if (!eraLength || !historyDepth) {
    return [{ text: '', value: 0 }];
  }

  const blocksPerDay = DAY_SECS.div(blockTime);
  const maxBlocks = eraLength.mul(historyDepth);
  const eraSelection: EraSelection[] = [];
  const days = new BN(2);

  while (true) {
    const dayBlocks = blocksPerDay.mul(days);

    if (dayBlocks.gte(maxBlocks)) {
      break;
    }

    eraSelection.push({
      text: t('{{days}} days', { replace: { days: days.toString() } }),
      value: dayBlocks.div(eraLength).toNumber()
    });

    days.imul(BN_THREE);
  }

  eraSelection.push({
    text: t('Max, {{eras}} eras', { replace: { eras: historyDepth.toNumber() } }),
    value: historyDepth.toNumber()
  });

  return eraSelection;
}

function Payouts ({ className = '', historyDepth, isInElection, ownPools, ownValidators }: Props): React.ReactElement<Props> {
  const { t } = useTranslation();
  const { api } = useApi();
  const [hasOwnValidators] = useState(() => ownValidators.length !== 0);
  const [myStashesIndex, setMyStashesIndex] = useState(() => hasOwnValidators ? 0 : 1);
  const [eraSelectionIndex, setEraSelectionIndex] = useState(0);
  const eraLength = useCall<BN>(api.derive.session.eraLength);
  const blockTime = useBlockInterval();

  const poolStashes = useMemo(
    () => ownPools?.map(({ stashId }) => stashId),
    [ownPools]
  );

  const eraSelection = useMemo(
    () => getOptions(blockTime, eraLength, historyDepth, t),
    [blockTime, eraLength, historyDepth, t]
  );

  const { allRewards, isLoadingRewards } = useOwnEraRewards(
    eraSelection[eraSelectionIndex].value,
    myStashesIndex ? undefined : ownValidators,
    poolStashes
  );

  const [fixedRewards, setFixedRewards] = useState<Record<string, DeriveStakerReward[]>>({});

  useEffect(() => {
    let isMounted = true;

    if (allRewards && Object.keys(allRewards).length) {
      (async () => {
        try {
          const corrected = await normalizeRewardsClaims(api, allRewards);

          if (isMounted) {
            setFixedRewards(corrected);
          }
        } catch {
          if (isMounted) {
            setFixedRewards(allRewards);
          }
        }
      })();
    } else {
      setFixedRewards(allRewards || {});
    }

    return () => {
      isMounted = false;
    };
  }, [api, allRewards]);

  const { stashAvail, stashes, valAvail, validators } = useMemo(
    () => getAvailable(fixedRewards),
    [fixedRewards]
  );

  const headerStashes = useMemo<[React.ReactNode?, string?, number?][]>(
    () => [
      [myStashesIndex ? t('payout/stash') : t('overall/validator'), 'start', 2],
      [t('eras'), 'start'],
      [myStashesIndex ? t('own') : t('total')],
      [('remaining')],
      [undefined, undefined, 3]
    ],
    [myStashesIndex, t]
  );

  const headerValidatorsRef = useRef<[React.ReactNode?, string?, number?][]>([
    [t('payout/validator'), 'start', 2],
    [t('eras'), 'start'],
    [t('own')],
    [('remaining')],
    [undefined, undefined, 3]
  ]);

  const valOptions = useMemo(() => [
    { isDisabled: !hasOwnValidators, text: t('Own validators'), value: 'val' },
    { text: t('Own stashes'), value: 'all' }
  ], [hasOwnValidators, t]);

  const footerStash = useMemo(() => (
    <tr>
      <td colSpan={3} />
      <Table.Column.Balance value={stashAvail} />
      <td colSpan={4} />
    </tr>
  ), [stashAvail]);

  const footerVal = useMemo(() => (
    <tr>
      <td colSpan={3} />
      <Table.Column.Balance value={valAvail} />
      <td colSpan={4} />
    </tr>
  ), [valAvail]);

  const payableValidators = useMemo(
    () => (validators || [])
      .map((v) => {
        const eras = v.eras.filter((e) => !e.isClaimed);
        const forcedAvailable = eras.reduce((acc, e) => {
          const eraSum = Object.values(e.stashes || {}).reduce((a: BN, b: BN) => a.add(b), new BN(0));

          return acc.add(eraSum);
        }, new BN(0));

        return { ...v, eras, available: forcedAvailable };
      })
      .filter((v) => !v.available.isZero()),
    [validators]
  );

  return (
    <StyledDiv className={className}>
      <Button.Group>
        <ToggleGroup
          onChange={setMyStashesIndex}
          options={valOptions}
          value={myStashesIndex}
        />
        <ToggleGroup
          onChange={setEraSelectionIndex}
          options={eraSelection}
          value={eraSelectionIndex}
        />
        <PayButton
          isAll
          isDisabled={isInElection || payableValidators.length === 0}
          payout={payableValidators}
        />
      </Button.Group>
      <ElectionBanner isInElection={isInElection} />
      {!isLoadingRewards && !stashes?.length && (
        <MarkWarning
          className='warning centered'
          withIcon={false}
        >
          <p>{t('Payouts of rewards for a validator can be initiated by any account. This means that as soon as a validator or nominator requests a payout for an era, all the nominators for that validator will be rewarded. Each user does not need to claim individually and the suggestion is that validators should claim rewards for everybody as soon as an era ends.')}</p>
          <p>{t('If you have not claimed rewards straight after the end of the era, the validator is in the active set and you are seeing no rewards, this would mean that the reward payout transaction was made by another account on your behalf. Always check your favorite explorer to see any historic payouts made to your accounts.')}</p>
        </MarkWarning>
      )}
      <Table
        empty={!isLoadingRewards && stashes && (
          myStashesIndex
            ? t('No pending payouts for your stashes')
            : t('No pending payouts for your validators')
        )}
        emptySpinner={t('Retrieving info for the selected eras, this will take some time')}
        footer={footerStash}
        header={headerStashes}
        isFixed
      >
        {!isLoadingRewards && stashes?.map((payout): React.ReactNode => (
          <Stash
            historyDepth={historyDepth}
            key={payout.stashId}
            payout={payout}
          />
        ))}
      </Table>
      {(myStashesIndex === 1) && !isLoadingRewards && validators && (validators.length !== 0) && validators.filter(({ eras }) => eras.some((e) => !e.isClaimed)).length > 0 && (
        <Table
          footer={footerVal}
          header={headerValidatorsRef.current}
          isFixed
        >
          {!isLoadingRewards && validators.filter(({ available }) => !available.isZero()).map((payout): React.ReactNode => (
            <Validator
              historyDepth={historyDepth}
              isDisabled={isInElection}
              key={payout.validatorId}
              payout={payout}
            />
          ))}
        </Table>
      )}
    </StyledDiv>
  );
}

const StyledDiv = styled.div`
  .payout-eras {
    padding-left: 0.25rem;
    vertical-align: middle;

    span {
      white-space: nowrap;
    }
  }
`;

export default React.memo(Payouts);
