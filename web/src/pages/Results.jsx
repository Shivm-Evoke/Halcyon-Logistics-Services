// Staff: the results as one screen: six months with the agents, then the decision that follows from it.
import SixMonths from './SixMonths.jsx';
import Decision from './Decision.jsx';

/** @returns Six months with agents followed by The decision */
export default function Results() {
  return (
    <>
      <SixMonths />
      <Decision />
    </>
  );
}
