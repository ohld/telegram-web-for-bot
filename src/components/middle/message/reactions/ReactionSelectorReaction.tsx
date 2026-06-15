import type { FC } from '../../../../lib/teact/teact';
import { memo } from '../../../../lib/teact/teact';

import type { ApiAvailableReaction, ApiReaction } from '../../../../api/types';

import buildClassName from '../../../../util/buildClassName';
import { REM } from '../../../common/helpers/mediaDimensions';

import useFlag from '../../../../hooks/useFlag';
import useMedia from '../../../../hooks/useMedia';

import AnimatedSticker from '../../../common/AnimatedSticker';
import Icon from '../../../common/icons/Icon';

import styles from './ReactionSelectorReaction.module.scss';

const REACTION_SIZE = 2 * REM;

type OwnProps = {
  reaction: ApiAvailableReaction;
  isReady?: boolean;
  chosen?: boolean;
  noAppearAnimation?: boolean;
  isLocked?: boolean;
  onToggleReaction: (reaction: ApiReaction) => void;
};

const ReactionSelectorReaction: FC<OwnProps> = ({
  reaction,
  isReady,
  noAppearAnimation,
  chosen,
  isLocked,
  onToggleReaction,
}) => {
  const appearAnimationId = reaction.appearAnimation?.id;
  const selectAnimationId = reaction.selectAnimation?.id;
  const staticIconId = reaction.staticIcon?.id;
  const mediaAppearData = useMedia(
    appearAnimationId ? `sticker${appearAnimationId}` : undefined,
    !isReady || noAppearAnimation,
  );
  const mediaData = useMedia(
    selectAnimationId ? `document${selectAnimationId}` : undefined,
    !isReady || noAppearAnimation,
  );
  const staticIconData = useMedia(staticIconId ? `document${staticIconId}` : undefined, !noAppearAnimation);
  const [isAnimationLoaded, markAnimationLoaded] = useFlag();
  const shouldRenderFallbackEmoji = reaction.reaction.type === 'emoji'
    && !reaction.appearAnimation
    && !reaction.selectAnimation
    && !reaction.staticIcon;

  const [isFirstPlay, , unmarkIsFirstPlay] = useFlag(true);
  const [isActivated, activate, deactivate] = useFlag();

  function handleClick() {
    onToggleReaction(reaction.reaction);
  }

  return (
    <div
      className={buildClassName(styles.root, chosen && styles.chosen)}
      onClick={handleClick}
      onMouseEnter={isReady && !isFirstPlay ? activate : undefined}
    >
      {shouldRenderFallbackEmoji ? (
        <span className={styles.fallbackEmoji}>{reaction.reaction.emoticon}</span>
      ) : noAppearAnimation && (
        <img
          className={styles.staticIcon}
          src={staticIconData}
          alt={reaction.reaction.emoticon}
          draggable={false}
        />
      )}
      {!shouldRenderFallbackEmoji && !isAnimationLoaded && !noAppearAnimation && (
        <AnimatedSticker
          key={appearAnimationId}
          tgsUrl={mediaAppearData}
          play={isFirstPlay}
          noLoop
          size={REACTION_SIZE}
          onEnded={unmarkIsFirstPlay}
          forceAlways
        />
      )}
      {!shouldRenderFallbackEmoji && !isFirstPlay && !noAppearAnimation && (
        <AnimatedSticker
          key={selectAnimationId}
          tgsUrl={mediaData}
          play={isActivated}
          noLoop
          size={REACTION_SIZE}
          onLoad={markAnimationLoaded}
          onEnded={deactivate}
          forceAlways
        />
      )}
      {isLocked && (
        <Icon className={styles.lock} name="lock-badge" />
      )}
    </div>
  );
};

export default memo(ReactionSelectorReaction);
