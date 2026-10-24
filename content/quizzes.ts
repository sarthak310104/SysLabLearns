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
};
