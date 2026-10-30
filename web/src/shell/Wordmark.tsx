// The wordmark is copied as is from design/brand/wordmark.svg; inlined so its level bar takes --level.
import svg from '../theme/wordmark.svg?raw';

export function Wordmark() {
  return <span className="wordmark" role="img" aria-label="Gimbal" dangerouslySetInnerHTML={{ __html: svg }} />;
}
