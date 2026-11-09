// The logo the owner picked (brand book C, mark B): two four-point stars, long and short, on one level, and the plain
// "gimbal" wordmark. Copied as is from the brand book's flat files; inlined so it takes the text colour (currentColor).
import lockup from '../theme/logo/lockup.svg?raw';

export function Wordmark() {
  return <span className="wordmark" role="img" aria-label="Gimbal" dangerouslySetInnerHTML={{ __html: lockup }} />;
}
