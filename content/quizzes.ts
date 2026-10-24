export interface Question {
  q: string;
  options: string[];
  /** Index into options. */
  answer: number;
  /** Why the answer is right, shown after you pick. */
  explain: string;
}

/** End-of-lesson questions, keyed by lesson slug. Each checks reasoning, not recall. */
export const QUIZZES: Record<string, Question[]> = {
  "a1-requests": [
    {
      q: "A server has 8 workers and each request takes 50 ms. Roughly how many requests per second can it handle at most?",
      options: ["50", "160", "400", "8"],
      answer: 1,
      explain: "Each worker finishes 1000 / 50 = 20 requests a second, and 8 workers give 160. That's the ceiling, and you'd want to run well below it.",
    },
    {
      q: "Your server is at 60% utilization and p99 latency is fine. Traffic grows so it reaches 95%. What happens to p99?",
      options: ["It grows by about 60%", "It stays about the same", "It grows far more than the traffic did", "It drops, because the server is warmed up"],
      answer: 2,
      explain: "Waiting time rises steeply as utilization approaches 100%: small bursts stack up faster than they clear. The last stretch of capacity is where latency explodes.",
    },
    {
      q: "Why does the lab show p99 instead of average latency?",
      options: [
        "Averages are harder to compute",
        "Averages hide the slow requests that real users notice",
        "p99 is always lower, so it looks better",
        "Databases only report percentiles",
      ],
      answer: 1,
      explain: "A handful of very slow requests barely moves the average, but at scale they hit thousands of people. p99 tells you what the unlucky 1% experience.",
    },
    {
      q: "A server is overloaded. Which outcome is better for users?",
      options: [
        "Accept every request into an unlimited queue and answer them all eventually",
        "Reject some requests immediately once the queue is full",
      ],
      answer: 1,
      explain: "An unlimited queue means everyone waits longer and longer, often past the point where they've given up. A fast rejection lets clients retry elsewhere or show an error right away.",
    },
    {
      q: "What's the main limit of scaling up (bigger machine) compared with scaling out (more machines)?",
      options: ["Scaling up is always slower", "There's a biggest machine you can buy", "Scaling up needs a load balancer", "Scaling up loses data"],
      answer: 1,
      explain: "Scaling up is simple and often the right first step, but a single machine has a ceiling, and it's also a single point of failure.",
    },
  ],
  "a2-load-balancing": [
    {
      q: "Three servers: two handle 100 req/s, one handles 40. Round robin sends 210 req/s. What goes wrong?",
      options: ["Nothing: total capacity is 240", "The slow server gets 70 req/s and overflows", "The fast servers overflow", "The load balancer overflows"],
      answer: 1,
      explain: "Round robin splits requests evenly, so each server gets 70. The slow one can only do 40, so its queue fills even though the system as a whole has spare capacity.",
    },
    {
      q: "Why does least connections handle a slow server well without knowing its speed?",
      options: [
        "It measures CPU usage",
        "A slow server holds requests longer, so it always looks busier",
        "It sends nothing to servers that are slow",
        "It asks each server for its capacity",
      ],
      answer: 1,
      explain: "Requests take longer to finish on a slow server, so its count of in-progress requests stays high and it naturally gets less new work.",
    },
    {
      q: "A server crashes and the load balancer has no health checks. What do clients see?",
      options: ["Nothing: the load balancer notices", "A share of requests fail until someone intervenes", "All requests fail", "Requests get slower but succeed"],
      answer: 1,
      explain: "The balancer keeps routing that server's share of traffic to it, and every one of those requests fails.",
    },
    {
      q: "You have 4 servers at 80% utilization. One crashes. With health checks on, what happens?",
      options: [
        "Everything is fine: health checks handle it",
        "The other three get its traffic and run at about 107%: overload",
        "Traffic drops by a quarter",
        "The crashed server's requests are queued until it returns",
      ],
      answer: 1,
      explain: "Health checks stop traffic going to the dead server, but the load still has to go somewhere. 4 x 80% spread over 3 servers is about 107%. That's why you plan for N+1 capacity.",
    },
    {
      q: "What does 'power of two choices' load balancing do?",
      options: [
        "Sends each request to two servers and uses the faster answer",
        "Picks two servers at random and sends to the less busy one",
        "Alternates between two strategies",
        "Uses two load balancers in a row",
      ],
      answer: 1,
      explain: "Comparing just two random servers gets most of the benefit of always picking the least busy one, with far less coordination.",
    },
  ],
  "a3-caching": [
    {
      q: "The API server's queue is full, but its workers are mostly waiting on database calls. Where's the bottleneck?",
      options: ["The API server", "The database", "The client", "The network"],
      answer: 1,
      explain: "The API server is a victim: its workers are stuck waiting. The component saturated by its own work, the database, is the real cause.",
    },
    {
      q: "Why does a small cache often absorb most of the reads?",
      options: [
        "Caches compress data",
        "Traffic is skewed: a few keys get most requests",
        "Caches never expire",
        "Reads are cheaper than writes",
      ],
      answer: 1,
      explain: "Real access patterns are lopsided. If the hottest 1% of items get 80% of reads, caching just those answers most requests.",
    },
    {
      q: "You raise the cache TTL from 5 seconds to 5 minutes. What's the trade-off?",
      options: [
        "Higher hit ratio, but readers can see older data",
        "Lower hit ratio, but fresher data",
        "More memory, nothing else",
        "Faster writes",
      ],
      answer: 0,
      explain: "Entries live longer, so more reads hit, but an update can take up to 5 minutes to show up for readers of the cached copy.",
    },
    {
      q: "Your database can only handle 30% of peak traffic without the cache. The cache restarts. What's the risk?",
      options: [
        "None: the cache refills itself",
        "Every request misses at once and the database can fall over before the cache warms up",
        "Data is lost",
        "The cache rejects all requests until it's warm",
      ],
      answer: 1,
      explain: "A cold cache sends everything to the database. If the database depends on the cache to survive, a restart can take it down: a cold-start outage.",
    },
    {
      q: "In cache-aside, what happens on a cache miss?",
      options: [
        "The request fails",
        "The app reads from the database and stores the answer in the cache",
        "The cache asks the database in the background and the request waits for the next one",
        "The database pushes the value into the cache",
      ],
      answer: 1,
      explain: "The application checks the cache, falls back to the database on a miss, and fills the cache with the result so the next read hits.",
    },
  ],
  "a4-replication": [
    {
      q: "Which load do read replicas help with?",
      options: ["Writes", "Reads", "Both equally", "Neither: they're only for backups"],
      answer: 1,
      explain: "Every write still has to go through the primary and then be applied on every replica. Replicas add read capacity only.",
    },
    {
      q: "A user changes their name, refreshes, and sees the old name. What's the likely cause?",
      options: ["The write failed", "Their read hit a replica that hadn't applied the write yet", "The cache is too big", "The primary is down"],
      answer: 1,
      explain: "That's a stale read caused by replication lag. Sending a user's reads to the primary for a short while after they write, called read-your-writes, avoids it.",
    },
    {
      q: "Why does a replica fall further behind when it's busy serving reads?",
      options: [
        "It stops applying writes while serving reads",
        "Applying writes and serving reads compete for the same machine",
        "The primary sends writes more slowly",
        "Reads invalidate the replica's data",
      ],
      answer: 1,
      explain: "A replica applies writes alongside serving queries. When reads keep it busy, each write takes longer to apply, and the gap grows.",
    },
    {
      q: "The primary crashes. What still works without any failover?",
      options: ["Reads and writes", "Reads only", "Writes only", "Nothing"],
      answer: 1,
      explain: "Replicas can keep answering reads, possibly slightly stale. Writes need a primary, so they fail until one is promoted.",
    },
    {
      q: "What's dangerous about promoting a replica during failover?",
      options: [
        "Replicas are read-only forever",
        "Writes the old primary accepted but never replicated can be lost",
        "It doubles the number of primaries permanently",
        "It deletes the old primary's data",
      ],
      answer: 1,
      explain: "With asynchronous replication, the newest writes may exist only on the old primary. If it's gone, so are they. And if it comes back thinking it's still primary, you have two.",
    },
  ],
  "a5-sharding": [
    {
      q: "What does a shard router use to decide where a request goes?",
      options: ["Which shard is least busy", "A hash of the request's key", "Round robin", "The client's location"],
      answer: 1,
      explain: "The key decides the shard, so the same key always lands where its data lives. Routing by load would send requests to shards that don't have the data.",
    },
    {
      q: "With 'hash mod N' routing, you go from 4 shards to 5. Roughly how many keys move to a different shard?",
      options: ["About 20%", "About 80%", "None", "Exactly one shard's worth"],
      answer: 1,
      explain: "Changing N changes the result of mod N for most keys, so most data has to move. Consistent hashing reduces this to about 1/N of the keys.",
    },
    {
      q: "One celebrity key gets 30% of all traffic. You double the number of shards. What happens to the hot shard?",
      options: ["Its load halves", "It stays overloaded: the key still lives on one shard", "The key splits across shards automatically", "It gets twice as much traffic"],
      answer: 1,
      explain: "Adding shards spreads keys, not the load of a single key. The celebrity's traffic still all lands on one shard.",
    },
    {
      q: "Which of these does NOT help with a single hot key?",
      options: ["A cache in front of the router", "Splitting the key into several smaller keys", "Replicating the hot key's data to several shards", "Adding more shards"],
      answer: 3,
      explain: "More shards don't change where that one key lives. The other three either answer it before the shard or spread it over several places.",
    },
    {
      q: "Why does sharding make a query like 'count all users' harder?",
      options: ["Users are deleted when shards are added", "The data is spread across every shard, so the query must ask all of them", "Shards can't run counts", "Counting requires a cache"],
      answer: 1,
      explain: "Queries that cross keys need a fan-out to every shard and a merge of the results. Sharding makes single-key operations easy and cross-key ones expensive.",
    },
  ],
  "a6-queues": [
    {
      q: "Which task is the best fit for a queue?",
      options: ["Checking a password at login", "Sending a welcome email after sign-up", "Showing the user's cart", "Loading a product page"],
      answer: 1,
      explain: "The user doesn't need to wait for the email to be sent. The other three need an answer before the page can respond.",
    },
    {
      q: "Workers handle 120 messages/s. Traffic averages 160 messages/s with spikes. What happens to the backlog over time?",
      options: ["It drains between spikes", "It grows without limit", "It stays flat", "It depends only on queue capacity"],
      answer: 1,
      explain: "Queues smooth out spikes only when workers keep up on average. If they can't, the backlog grows forever, however big the queue is.",
    },
    {
      q: "Which number best tells you how late users' work is running?",
      options: ["Messages per second", "Number of workers", "Age of the oldest waiting message", "Queue capacity"],
      answer: 2,
      explain: "The oldest message's age is how long the unluckiest piece of work has waited. A short queue of very slow work can still be late.",
    },
    {
      q: "All workers crash. What do users of the API see, in a well-built queue setup?",
      options: ["Errors on every request", "Fast 'accepted' answers; the work waits until workers return", "Timeouts", "The API crashes too"],
      answer: 1,
      explain: "The queue decouples the two sides. The API keeps accepting work, and the backlog is processed once workers recover.",
    },
    {
      q: "What is a dead-letter queue for?",
      options: ["Messages for deleted users", "Messages that keep failing after several delivery attempts", "Messages older than a day", "Messages sent while the queue was down"],
      answer: 1,
      explain: "Some messages fail every time, for example because they're malformed. Moving them aside stops them blocking the queue and lets someone inspect them.",
    },
  ],
  "a7-resilience": [
    {
      q: "A database can still serve 160 req/s, users send 200, yet almost nothing succeeds. What's the most likely cause?",
      options: [
        "The database is broken",
        "Requests wait in long queues past the client's timeout, so the work done is wasted",
        "The network is cut",
        "The load balancer is misconfigured",
      ],
      answer: 1,
      explain: "That's goodput collapse: plenty of work is done, but on requests nobody is still waiting for.",
    },
    {
      q: "Why does a short queue that rejects requests early improve success?",
      options: [
        "It makes the database faster",
        "Requests either get served soon or fail fast, so capacity goes to requests someone is waiting for",
        "Rejected requests are retried automatically",
        "It reduces network latency",
      ],
      answer: 1,
      explain: "Load shedding keeps the queue short enough that the work being done is still useful when it finishes.",
    },
    {
      q: "Clients retry up to 3 times immediately on failure. The backend starts failing everything. How much load can clients now generate?",
      options: ["The same as before", "Up to 2x", "Up to 4x", "Less, because they give up"],
      answer: 2,
      explain: "One original attempt plus three retries is four attempts per request, all aimed at a system that's already failing.",
    },
    {
      q: "What does a retry budget of 10% mean?",
      options: [
        "Each request can be retried 10 times",
        "Retries can make up at most 10% of the requests being sent",
        "Wait 10% longer between each retry",
        "Retry only 10% of the time, at random",
      ],
      answer: 1,
      explain: "During a blip, 10% is plenty to smooth over failures. During an outage, it caps the extra load at 10% instead of 300%.",
    },
    {
      q: "Calls to a dependency get no answer at all. Without a timeout, what happens to the caller?",
      options: ["It retries automatically", "Its workers wait forever and it eventually freezes", "It fails fast", "Nothing: the request is dropped"],
      answer: 1,
      explain: "Each stuck call holds a worker. Once every worker is stuck, the service can't answer anything, even requests that don't need that dependency.",
    },
  ],
  "a8-partitions": [
    {
      q: "During a network partition, what can't a system guarantee at the same time?",
      options: ["Speed and cost", "Consistency and availability", "Reads and writes", "Durability and latency"],
      answer: 1,
      explain: "If the two sides can't talk, either some writes are refused (consistent) or both sides accept writes that may conflict (available).",
    },
    {
      q: "Two regions accept writes during a partition and both change the same key. With last-writer-wins, what happens when they reconnect?",
      options: ["Both changes are kept", "One change is silently lost", "The key is deleted", "Writes fail until someone decides"],
      answer: 1,
      explain: "Only one version survives, so the other change disappears: a lost update.",
    },
    {
      q: "Why are writes slower in consistent mode, even when nothing is broken?",
      options: [
        "Consistent mode uses a slower disk",
        "Each write waits for the other region to confirm it",
        "Consistent mode disables caching",
        "Writes are retried twice",
      ],
      answer: 1,
      explain: "Confirming with another region adds a cross-region round trip to every write. Consistency costs latency all the time, not just during failures.",
    },
    {
      q: "Which data would you most likely keep consistent, refusing writes during a partition?",
      options: ["A shopping cart", "A bank account balance", "A 'likes' counter", "A user's theme preference"],
      answer: 1,
      explain: "Two regions both spending the same money is worse than a brief error. A cart or a like count can usually merge or tolerate a small mistake.",
    },
    {
      q: "From one database's point of view, how does a partition differ from the other region being down?",
      options: ["It gets an error message saying which", "It can't tell: in both cases it just gets no answer", "Partitions are always faster to detect", "Down regions send a goodbye message"],
      answer: 1,
      explain: "Silence looks the same either way. That uncertainty is exactly what makes distributed systems hard, and it's the starting point of the protocols track.",
    },
  ],
  "a9-cdn": [
    {
      q: "A user in Mumbai calls a server in Virginia that does 20 ms of work. Roughly how long does the request take?",
      options: ["About 20 ms", "About 115 ms", "About 210 ms", "About 2 seconds"],
      answer: 2,
      explain: "About 95 ms there and 95 ms back, plus 20 ms of work. Travel dominates, and faster code can't remove it.",
    },
    {
      q: "After adding a CDN with a 95% hit ratio, which number improves most?",
      options: ["p50 (typical latency)", "p99 (slowest 1%)", "Both equally", "Neither"],
      answer: 0,
      explain: "Most requests become fast hits, so the typical request improves dramatically. The 5% of misses still make the full trip, and they're exactly the ones p99 measures.",
    },
    {
      q: "Which page is the worst fit for CDN caching?",
      options: ["A company logo", "A public product page", "A user's account settings page", "A JavaScript bundle"],
      answer: 2,
      explain: "A personal page can't be shown to the next visitor. It must skip the shared cache or be split into a shared part and a small personal request.",
    },
    {
      q: "Why do sites put a version in file names, like app.3f9a2c.js?",
      options: ["To make files smaller", "So a new release is a new file, and old cached copies never need purging", "Search engines prefer it", "It hides the source code"],
      answer: 1,
      explain: "Old versions can stay cached forever because nothing points to them any more. The new release has a new name, so nobody can get a stale copy.",
    },
    {
      q: "The origin goes down. Why do many users still get answers?",
      options: ["The CDN rebuilds the site", "Popular content is already cached at the edge", "The CDN starts its own database", "Requests are queued"],
      answer: 1,
      explain: "Cached content can be served until it expires, and many CDNs can serve stale copies when the origin is unreachable.",
    },
  ],
  "a10-consistent-hashing": [
    {
      q: "A sharded cache uses hash mod N with 10 shards. You add an 11th. Roughly what share of keys move?",
      options: ["About 9%", "About 50%", "About 90%", "None"],
      answer: 2,
      explain: "Changing the divisor changes the remainder for almost every key, so roughly 10 in 11 keys now map somewhere else.",
    },
    {
      q: "Why is moving keys especially painful for a sharded cache?",
      options: ["Caches can't store moved keys", "Every moved key becomes a miss that lands on the database at the same time", "The router has to restart", "Moved keys are deleted from the database"],
      answer: 1,
      explain: "The new owner of a key has never seen it, so it misses. When most keys move at once, the database gets the whole load in one wave.",
    },
    {
      q: "With consistent hashing, which keys does a new shard take over?",
      options: ["A random selection from every shard", "Small slices from the shards next to it on the ring", "All of one existing shard's keys", "Only new keys"],
      answer: 1,
      explain: "Each key belongs to the next shard clockwise. A new shard's points on the ring take over only the arcs just before them.",
    },
    {
      q: "What are virtual nodes for?",
      options: ["Testing without real servers", "Placing each shard at many points on the ring so the slices are even", "Backing up keys", "Encrypting keys"],
      answer: 1,
      explain: "With one point per shard, the arcs can be very uneven by chance. Many points per shard average that out.",
    },
    {
      q: "A shard dies. With consistent hashing and health checks, what happens to its keys?",
      options: ["They fail until it returns", "They go to the next live shard on the ring and miss once", "Every key is remapped", "They're spread randomly"],
      answer: 1,
      explain: "Only the dead shard's keys move, to its neighbour, which fetches them from the database once. Everyone else is unaffected.",
    },
  ],
  "a11-rate-limiting": [
    {
      q: "In a token bucket, what does the size of the bucket control?",
      options: ["The long-run rate", "How big a short burst can be", "How many clients there are", "How long requests wait"],
      answer: 1,
      explain: "Tokens refill at the allowed rate; a full bucket lets a burst through all at once. A bigger bucket allows bigger bursts.",
    },
    {
      q: "A shared limit of 450 req/s is set. Normal users send 200 and a script sends 600. Roughly how many of the normal users' requests get through?",
      options: ["All 200", "About 110", "About 50", "None"],
      answer: 1,
      explain: "The limit lets through 450 of 800 requests, about 56% of everyone's traffic. Normal users get the same share: about 110 of their 200.",
    },
    {
      q: "Why is rejecting excess requests at the gateway better than letting servers deal with them?",
      options: ["Servers can't reject requests", "Rejecting at the door is cheap and fast; overloaded servers slow down for everyone", "Gateways are faster servers", "It hides errors from users"],
      answer: 1,
      explain: "A quick rejection costs almost nothing. Excess work inside the system fills queues and slows down requests that would otherwise have succeeded.",
    },
    {
      q: "Which HTTP status code means 'too many requests'?",
      options: ["404", "429", "500", "503"],
      answer: 1,
      explain: "429 tells the client it's being rate limited, ideally with a hint about when to retry, so a well-behaved client can back off.",
    },
    {
      q: "What does fair queuing do differently from first come, first served?",
      options: ["Serves the oldest requests first", "Gives each client a turn, so one client's burst can't starve the others", "Drops requests at random", "Serves premium clients only"],
      answer: 1,
      explain: "Taking turns between clients means a flood from one client queues behind itself, not in front of everyone else.",
    },
  ],
  "a12-autoscaling": [
    {
      q: "New workers take 60 seconds to start. Which traffic pattern can autoscaling handle?",
      options: ["A 5-second burst", "A rise that takes 20 minutes", "A traffic spike at a match kick-off", "None"],
      answer: 1,
      explain: "Autoscaling can only keep up with change that's slower than its start-up time. A slow daily rise gives it plenty of time.",
    },
    {
      q: "Why does an autoscaler always lag behind traffic?",
      options: ["It's poorly programmed", "It reacts to load it has already measured, then waits for new capacity to start", "It only runs once an hour", "Cloud providers delay it on purpose"],
      answer: 1,
      explain: "It has to see high load first, then order capacity, then wait for it to boot. That delay is unavoidable.",
    },
    {
      q: "You know a flash sale starts at 9 am. What's the best plan?",
      options: ["Rely on autoscaling", "Scale up shortly before 9 am", "Add a cache", "Lower the timeout"],
      answer: 1,
      explain: "Scheduled scaling uses what you already know. Capacity is ready before the spike instead of arriving after it.",
    },
    {
      q: "What does keeping headroom cost you?",
      options: ["Nothing", "Paying for idle capacity all the time", "Slower requests", "More errors"],
      answer: 1,
      explain: "Spare capacity only helps if it's already running, which means paying for it even when traffic is low.",
    },
    {
      q: "An autoscaler removes workers the moment load drops, then adds them back a minute later, over and over. What's this called, and what's the usual fix?",
      options: ["Thrashing; add more memory", "Flapping; wait longer before scaling down", "Throttling; add a rate limit", "Sharding; add more shards"],
      answer: 1,
      explain: "Flapping wastes start-up time and leaves the system under-provisioned when traffic returns. A cool-down before removing capacity smooths it out.",
    },
  ],
"b1-clocks": [
    {
      q: "Server A logs an event at 10:00:00.003 by its own clock, and server B logs one at 10:00:00.001 by its clock. What can you conclude?",
      options: ["B's event came first", "A's event came first", "Nothing about their order, from the clocks alone", "They happened at the same time"],
      answer: 2,
      explain: "Clocks on different machines drift and get corrected at different moments, so a few milliseconds of difference tells you nothing. Only causality, carried by messages, orders events across machines.",
    },
    {
      q: "Event a has Lamport time 3 and event b has Lamport time 7. What do you know?",
      options: ["a happened before b", "b did not happen before a", "a and b are concurrent", "a and b are on the same process"],
      answer: 1,
      explain: "If b happened before a, b's Lamport time would have to be smaller. It isn't, so b didn't. But a smaller time doesn't prove a came first: they could still be concurrent.",
    },
    {
      q: "Why does a Lamport receive take the larger of its own counter and the message's stamp?",
      options: [
        "To keep counters small",
        "So the receive is stamped later than the send that caused it",
        "So all processes end up with the same counter",
        "To detect lost messages",
      ],
      answer: 1,
      explain: "The send happened before the receive. Jumping past the sender's stamp guarantees the receive gets a bigger number, and chains of messages carry that guarantee along.",
    },
    {
      q: "Two events have vector stamps {p1: 2, p2: 0} and {p1: 1, p2: 3}. How are they related?",
      options: ["The first happened before the second", "The second happened before the first", "They are concurrent", "They are the same event"],
      answer: 2,
      explain: "The first is bigger in p1's slot and the second is bigger in p2's. Neither is less than or equal to the other in every slot, so neither could have known about the other.",
    },
    {
      q: "What do vector clocks give you that Lamport clocks don't, and at what cost?",
      options: [
        "Real wall-clock times, at the cost of a time server",
        "Exactly whether two events are causally related, at the cost of one counter per process",
        "Protection against lost messages, at the cost of retries",
        "A total order of all events, at the cost of extra messages",
      ],
      answer: 1,
      explain: "Comparing vectors tells you before, after or concurrent, with no false answers. The price is size: every stamp carries an entry for every process.",
    },
  ],
  "b2-rpc": [
    {
      q: "A client sends a request and hears nothing back. What does it know?",
      options: ["The server never got it", "The server crashed", "Either the request or the reply was lost, and it can't tell which", "The server is overloaded"],
      answer: 2,
      explain: "A lost request and a lost reply look the same from the client's side. That ambiguity is why retries alone can run an operation twice.",
    },
    {
      q: "Which operation is safe to retry without any duplicate detection?",
      options: ["Append \"x\" to a string", "Add 10 to a balance", "Read the current value of a key", "Send an email"],
      answer: 2,
      explain: "Reading twice gives the same result and changes nothing, so it's idempotent. The others have an effect that doubles if they run twice.",
    },
    {
      q: "Why can the server get away with remembering just one entry per client in its duplicate table?",
      options: [
        "Clients never retry more than once",
        "Each client has only one request outstanding, so anything older is already answered",
        "The network never delivers old messages",
        "The table is cleared after every reply",
      ],
      answer: 1,
      explain: "A client only sends request n+1 after it has the reply to n. So once the server sees n+1, nothing older needs an answer, and old copies can be ignored.",
    },
    {
      q: "A server keys its duplicate table by request number only, not by client. What goes wrong?",
      options: [
        "Nothing, numbers are unique",
        "Two clients both send request 1, and the second one gets the first one's answer instead of having its own done",
        "The table grows without limit",
        "Replies get lost",
      ],
      answer: 1,
      explain: "Request numbers are only unique per client. Client 2's first request looks like a repeat of client 1's, so its work is skipped and it gets someone else's result.",
    },
    {
      q: "Random testing passes, but the model checker finds a failure. What does that usually mean?",
      options: [
        "The model checker is too strict",
        "The bug needs a specific, rare ordering of messages that random runs didn't happen to hit",
        "The code has a syntax error",
        "The network settings are different",
      ],
      answer: 1,
      explain: "The checker tries every ordering, shortest first. Bugs that need, say, a very old duplicate arriving at exactly the wrong moment are rare in random runs but certain in an exhaustive search.",
    },
  ],
  "b3-primary-backup": [
    {
      q: "Why must the primary wait for the backup's confirmation before replying to the client?",
      options: [
        "To make replies faster",
        "So that anything a client was told about survives if the primary crashes",
        "So the backup can reply instead",
        "To balance load between servers",
      ],
      answer: 1,
      explain: "If the primary replies first and then crashes, the backup takes over without that change. The client was told it happened, but it's gone.",
    },
    {
      q: "Why does the duplicate table have to be copied to the backup, not just the data?",
      options: [
        "It's needed for reads",
        "After a failover, a client's retry of an already-applied request would otherwise be applied again",
        "To save memory on the primary",
        "The view server reads it",
      ],
      answer: 1,
      explain: "A client whose reply was lost retries against the new primary. Without the old duplicate table, the new primary can't tell it's a repeat and does it twice.",
    },
    {
      q: "Why not let two servers decide between themselves which one is primary?",
      options: [
        "It would be too slow",
        "If they lose contact, each may decide it's in charge, and both accept different writes",
        "Servers can't send messages to each other",
        "It needs more than two servers",
      ],
      answer: 1,
      explain: "A server can't tell a dead peer from an unreachable one. Two servers each deciding alone can end up as two primaries: split brain. A single referee avoids that.",
    },
    {
      q: "The view server won't change views until the primary acknowledges the current view. What does this prevent?",
      options: [
        "Too many view changes",
        "Promoting a backup that was never brought up to date",
        "Clients talking to the wrong server",
        "Lost pings",
      ],
      answer: 1,
      explain: "The primary only acknowledges once its backup has a full copy. Without the rule, the view server could promote a backup that's still empty.",
    },
    {
      q: "A server restarts after a crash and gets an old, delayed view message saying it's the primary. What should it do?",
      options: [
        "Start serving clients",
        "Refuse to act as primary until it has a copy of the data",
        "Copy data to the backup",
        "Delete the view server's state",
      ],
      answer: 1,
      explain: "It restarted empty. Serving clients would hand out answers based on no data. It should treat itself as unsynced until a state transfer gives it real data.",
    },
  ],
  "b4-paxos": [
    {
      q: "When exactly is a value chosen in Paxos?",
      options: [
        "When the proposer decides it",
        "When a majority of acceptors accept it in the same ballot",
        "When every acceptor has accepted it",
        "When the first acceptor accepts it",
      ],
      answer: 1,
      explain: "The decision is made at the acceptors. Once a majority accept in one ballot, the value is fixed, even if no proposer has heard yet.",
    },
    {
      q: "Why must a proposer use the value from the highest-ballot accepted value in its promises?",
      options: [
        "It's the most popular value",
        "That value may already be chosen, and proposing anything else could choose a second value",
        "Higher ballots are always correct",
        "To finish faster",
      ],
      answer: 1,
      explain: "Any two majorities overlap, so if a value was chosen earlier, at least one promise reports it. Proposing it keeps every later ballot consistent with that earlier decision.",
    },
    {
      q: "With three acceptors, why does any prepare majority learn about a value chosen earlier?",
      options: [
        "Acceptors broadcast every decision",
        "Any two groups of two out of three share at least one acceptor",
        "Proposers keep a log",
        "The network delivers everything eventually",
      ],
      answer: 1,
      explain: "Two majorities of three must overlap in at least one acceptor. That acceptor accepted the chosen value and reports it in its promise.",
    },
    {
      q: "A proposer counts every accepted message it receives toward its majority. What breaks?",
      options: [
        "Nothing",
        "One acceptor's message delivered twice looks like a majority, so it decides a value that wasn't chosen",
        "It decides too slowly",
        "Ballots stop being unique",
      ],
      answer: 1,
      explain: "The network can repeat messages. A majority has to be distinct acceptors, so the proposer must count who replied, not how many replies arrived.",
    },
    {
      q: "Two proposers keep pre-empting each other's ballots and nothing is ever chosen. Is that a safety bug?",
      options: [
        "Yes, two values could be chosen",
        "No, it's a liveness problem: nothing wrong is decided, it just never finishes",
        "Yes, acceptors lose their state",
        "No, it can't happen in Paxos",
      ],
      answer: 1,
      explain: "Duelling proposers never cause a wrong decision, only no decision. Random back-off or a single leader makes progress likely in practice.",
    },
  ],
  "c1-cloud-basics": [
    {
      q: "What is an AWS region?",
      options: ["A pricing plan", "A group of data centres in one part of the world, like Mumbai", "A folder inside your account", "A type of server"],
      answer: 1,
      explain: "Regions are separate geographic locations such as ap-south-1 (Mumbai). Resources you create live in one region, so you pick one near your users.",
    },
    {
      q: "Which command shape does the AWS CLI always use?",
      options: ["aws --service s3 ls", "aws <service> <command> --options", "s3 aws <command>", "aws <command> <service>"],
      answer: 1,
      explain: "Service first, then the command for that service, then options: aws s3 ls, aws sts get-caller-identity, aws dynamodb put-item --table-name ...",
    },
    {
      q: "You want just your account number, with no quotes or braces. What do you add?",
      options: ["--output json", "--query Account --output text", "--account", "| cat"],
      answer: 1,
      explain: "--query picks one field out of the JSON answer, and --output text prints it plain, ready to save in a variable.",
    },
    {
      q: "What does Q=$(aws sqs get-queue-url --queue-name orders --query QueueUrl --output text) do?",
      options: ["Creates a queue called Q", "Runs the command and saves its output in the variable Q", "Prints the URL", "Deletes the queue"],
      answer: 1,
      explain: "$(...) runs a command and gives back its output; NAME=... stores it. Later commands use it as $Q.",
    },
    {
      q: "In arn:aws:iam::123456789012:user/you, why is the region part empty?",
      options: ["It's a mistake", "IAM is global, not tied to one region", "The user was deleted", "Regions are always left out"],
      answer: 1,
      explain: "ARNs are arn:aws:service:region:account:resource. IAM users and roles exist across all regions, so that field is blank.",
    },
  ],
  "c2-s3": [
    {
      q: "Why might aws s3 mb s3://photos fail even on a brand new account?",
      options: ["Buckets need a region prefix", "Bucket names are global, and someone else already owns that one", "Names can't contain letters", "You need versioning first"],
      answer: 1,
      explain: "Bucket names are shared by every AWS customer. Short common names were taken long ago, so add something unique like your name.",
    },
    {
      q: "What is photos/cat.jpg inside a bucket?",
      options: ["A file cat.jpg inside a real folder", "An object whose key is the text photos/cat.jpg", "Two objects", "A bucket called photos"],
      answer: 1,
      explain: "S3 has no real folders. The key contains a slash, and tools group keys by prefix so they look like folders.",
    },
    {
      q: "You curl an object's URL in a new bucket and get AccessDenied. Why?",
      options: ["The object doesn't exist", "New buckets block public access, so nothing is readable without permission", "curl isn't allowed", "The bucket is in another region"],
      answer: 1,
      explain: "S3 is private by default and Block Public Access is on for new buckets. That stops accidental leaks.",
    },
    {
      q: "What's the safest way to let a colleague download one file for an hour?",
      options: ["Make the bucket public", "Email them your access key", "A presigned URL that expires in 3600 seconds", "Copy the file to their bucket"],
      answer: 2,
      explain: "A presigned URL grants access to one object, using your permissions, for a limited time. Nothing else becomes public.",
    },
    {
      q: "With versioning on, you overwrite report.csv by mistake. What now?",
      options: ["It's gone", "The old version is still there and can be fetched by its VersionId", "Only the newest is kept", "S3 restores it automatically"],
      answer: 1,
      explain: "Versioning keeps every version. list-object-versions shows them, and get-object --version-id fetches an old one.",
    },
  ],
  "c3-iam": [
    {
      q: "A brand new IAM user with no policies runs aws s3 ls. What happens?",
      options: ["It lists every bucket", "AccessDenied: everything is denied unless a policy allows it", "It lists only their own buckets", "It asks for a password"],
      answer: 1,
      explain: "IAM denies by default. Nothing works until a policy allows it.",
    },
    {
      q: "One policy allows s3:* on a bucket; another explicitly denies s3:DeleteObject on it. Can the user delete objects?",
      options: ["Yes, Allow comes first", "No, an explicit Deny always wins", "Only with the console", "It depends on the order the policies were attached"],
      answer: 1,
      explain: "If any matching statement denies, the request is denied, whatever else allows it.",
    },
    {
      q: "Which identity does a Lambda function run as?",
      options: ["Your IAM user", "The root user", "A role it's allowed to take on", "No identity at all"],
      answer: 2,
      explain: "Services use roles: identities without passwords that the service takes on, with permissions from the role's policies.",
    },
    {
      q: "An intern needs to read one bucket. What's least privilege?",
      options: ["AdministratorAccess", "AmazonS3FullAccess", "AmazonS3ReadOnlyAccess", "A policy allowing s3:ListBucket on that bucket and s3:GetObject on its objects"],
      answer: 3,
      explain: "Least privilege is exactly what the job needs. Read-only for all of S3 still exposes every other bucket.",
    },
    {
      q: "To allow downloading objects from my-bucket, which Resource does the policy need?",
      options: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*", "my-bucket", "s3://my-bucket"],
      answer: 1,
      explain: "GetObject acts on objects, so the ARN needs /* for the objects inside. ListBucket acts on the bucket itself, without /*.",
    },
  ],
  "c4-sqs": [
    {
      q: "A worker receives a message and then crashes before deleting it. What happens to the message?",
      options: ["It's lost", "It reappears after the visibility timeout and another worker gets it", "It moves straight to the dead-letter queue", "It stays hidden forever"],
      answer: 1,
      explain: "Receiving only hides a message. Without a delete, it becomes visible again when the timeout ends.",
    },
    {
      q: "Why should a consumer be safe to run twice on the same message?",
      options: ["SQS sends everything twice", "Delivery is at-least-once: a message can come back if a worker finished but didn't delete in time", "It's faster", "FIFO queues require it"],
      answer: 1,
      explain: "Standard queues guarantee at-least-once delivery, so occasional duplicates happen. Idempotent processing makes them harmless.",
    },
    {
      q: "Processing a message takes up to 60 seconds, and the visibility timeout is 30. What goes wrong?",
      options: ["Nothing", "Messages reappear while still being worked on, so another worker processes them too", "Messages are deleted early", "The queue fills up"],
      answer: 1,
      explain: "Set the visibility timeout longer than the work takes, or the message comes back mid-job.",
    },
    {
      q: "What does a dead-letter queue do?",
      options: ["Deletes old messages", "Catches messages that failed too many times, so they stop being retried forever", "Speeds up delivery", "Stores deleted messages"],
      answer: 1,
      explain: "After maxReceiveCount receives without a delete, SQS moves the message to the DLQ where you can inspect it.",
    },
    {
      q: "What do you need to delete a specific message you received?",
      options: ["Its MessageId", "Its body", "Its ReceiptHandle from that receive", "The queue's ARN"],
      answer: 2,
      explain: "delete-message takes the receipt handle you got when receiving. It proves you're the one holding it right now.",
    },
  ],
  "c5-sns": [
    {
      q: "You publish one message to a topic with three subscribed queues. How many copies are delivered?",
      options: ["One, to whichever queue is free", "Three, one per queue", "Zero until a queue asks", "Six"],
      answer: 1,
      explain: "SNS fans out: every subscriber gets its own copy.",
    },
    {
      q: "Why put an SQS queue behind each SNS subscriber instead of calling services directly?",
      options: ["It's required", "Each consumer gets a buffer: it can be slow or down without missing messages", "SQS is cheaper than SNS", "SNS can't call services"],
      answer: 1,
      explain: "SNS keeps nothing; SQS holds each consumer's messages until it's ready.",
    },
    {
      q: "A message from SNS arrives in SQS wrapped in JSON with Type, TopicArn and Message fields. What is that?",
      options: ["An error", "The SNS envelope; your text is in Message, unless raw delivery is turned on", "A dead letter", "A duplicate"],
      answer: 1,
      explain: "SNS wraps messages in an envelope by default. RawMessageDelivery=true sends just the message.",
    },
    {
      q: "How can one subscriber receive only messages about big orders?",
      options: ["Use a separate topic per size", "A filter policy on its subscription that matches a message attribute", "Delete small ones from its queue", "It can't"],
      answer: 1,
      explain: "Filter policies compare message attributes, so a subscription only receives matching messages.",
    },
    {
      q: "Which pairing describes SNS and SQS?",
      options: ["Both store messages for days", "SNS copies an event to many listeners now; SQS holds work until a consumer takes it", "SQS fans out; SNS buffers", "They're the same"],
      answer: 1,
      explain: "SNS is publish/subscribe with no storage; SQS is a queue. Together: fan out, then buffer.",
    },
  ],
  "c6-dynamodb": [
    {
      q: "What must every item in a DynamoDB table have?",
      options: ["The same attributes as every other item", "The table's primary key attributes", "A timestamp", "An id attribute"],
      answer: 1,
      explain: "Only the key is required. Other attributes can differ from item to item.",
    },
    {
      q: "A query returns Count 2, ScannedCount 2. A scan with a filter returns Count 2, ScannedCount 50000. What's the difference?",
      options: ["Nothing", "The scan read the whole table and you pay for all 50,000 reads", "The scan was faster", "The query was wrong"],
      answer: 1,
      explain: "Scan reads everything then filters. Query goes straight to matching keys. Design keys so common lookups are queries.",
    },
    {
      q: "Two users create an account with the same username at the same moment. How do you stop one overwriting the other?",
      options: ["Scan first to check", "put-item with --condition-expression attribute_not_exists(username)", "Use a bigger table", "Use a sort key"],
      answer: 1,
      explain: "A condition expression makes the check and the write one step, so the second writer gets ConditionalCheckFailedException.",
    },
    {
      q: "Why use update-item with ADD for a view counter, instead of read, add one, write?",
      options: ["It's shorter", "Two writers at once could both read 5 and both write 6, losing an update; ADD changes it inside the database", "Reads are expensive", "ADD is required for numbers"],
      answer: 1,
      explain: "Read-modify-write races lose updates. ADD applies the change atomically on the server.",
    },
    {
      q: "Your filter uses status and fails with 'Attribute name is a reserved keyword'. Fix?",
      options: ["Rename the attribute in every item", "Use a placeholder: #s in the expression and --expression-attribute-names '{\"#s\":\"status\"}'", "Use scan instead", "Quote it"],
      answer: 1,
      explain: "Reserved words need #placeholders mapped to the real name.",
    },
  ],
  "c7-lambda": [
    {
      q: "What does a Lambda handler receive and return?",
      options: ["An HTTP request and HTML", "An event (JSON describing what happened) and a result", "A file and a file", "Nothing; it only logs"],
      answer: 1,
      explain: "AWS calls your handler with an event and uses its return value as the result.",
    },
    {
      q: "create-function fails with 'The role defined for the function cannot be assumed by Lambda'. What's wrong?",
      options: ["The code has a bug", "The role's trust policy doesn't name lambda.amazonaws.com", "The zip is too big", "The runtime is wrong"],
      answer: 1,
      explain: "The trust policy says who may take on the role. It must allow the Lambda service.",
    },
    {
      q: "Your function runs but nothing ever appears in CloudWatch Logs. Most likely cause?",
      options: ["console.log is disabled", "The role lacks permission to write logs (AWSLambdaBasicExecutionRole)", "Logs take a day to appear", "The function is too fast"],
      answer: 1,
      explain: "Writing logs is an AWS call like any other. Without logs permissions on the role, they're silently dropped.",
    },
    {
      q: "The first invoke's REPORT line shows Init Duration; later ones don't. Why?",
      options: ["The first run failed", "A cold start: AWS set up a fresh copy of the function, which later runs reuse", "Logging was off later", "Billing changed"],
      answer: 1,
      explain: "New execution environments load your code first. Warm ones skip that.",
    },
    {
      q: "With an SQS trigger, your function throws an error on a batch. What happens to those messages?",
      options: ["They're deleted", "They return after the visibility timeout and are retried, eventually reaching the dead-letter queue", "They're sent to SNS", "The trigger is disabled"],
      answer: 1,
      explain: "Lambda deletes messages only on success. Failures go back to the queue and follow its redrive policy.",
    },
  ],
  "c8-serverless-api": [
    {
      q: "curl returns Internal Server Error and the function's logs show nothing new. What's the likely cause?",
      options: ["A bug in the code", "API Gateway isn't allowed to invoke the function (no lambda add-permission)", "DynamoDB is down", "The table is empty"],
      answer: 1,
      explain: "If the function never ran, API Gateway couldn't call it. The function's resource policy must allow apigateway.amazonaws.com.",
    },
    {
      q: "Now the logs show AccessDeniedException for dynamodb:PutItem. What fixes it?",
      options: ["add-permission again", "Give the function's role permission to PutItem on the table", "Make the table public", "Restart the function"],
      answer: 1,
      explain: "The function runs as its role, and the role has no DynamoDB permissions yet.",
    },
    {
      q: "Why create the DynamoDB client outside the handler?",
      options: ["It's required by Lambda", "It's created once per copy of the function and reused across requests", "It runs faster in the cloud", "Handlers can't import"],
      answer: 1,
      explain: "Code outside the handler runs at cold start. Reusing the client avoids setting it up for every request.",
    },
    {
      q: "Which policy follows least privilege for this function?",
      options: ["AdministratorAccess", "AmazonDynamoDBFullAccess", "dynamodb:PutItem and dynamodb:Scan on the Notes table only", "dynamodb:* on all tables"],
      answer: 2,
      explain: "Allow only the actions the code uses, on the one table it uses.",
    },
    {
      q: "What's a real downside of this serverless design?",
      options: ["You must patch servers", "Cold starts, and per-request pricing that can cost more than servers at very high steady traffic", "It can't scale", "It can't store data"],
      answer: 1,
      explain: "Serverless removes server work and scales on its own, but each request is billed and new copies start cold.",
    },
  ],
};
