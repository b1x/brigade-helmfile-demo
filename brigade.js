const {events, Job, Group} = require("brigadier")
const gh = require("./http")
const dest = "/workspace"
const image = "mumoshu/helmfile-chatops:0.2.0"

async function handleIssueComment(e, p) {
    console.log("handling issue comment....")
    payload = JSON.parse(e.payload);

    // Extract the comment body and trim whitespace
    comment = payload.body.comment.body.trim();

    console.log("project", p)
    console.log("payload", payload)
    console.log("owner", payload.body.repository.owner)

    tmp = payload.body.repository.owner.html_url.split('/')
    let owner = tmp[tmp.length - 1]
    let repo = payload.body.repository.name;
    let issue = payload.body.issue.number;
    let ghtoken = p.secrets.githubToken;

    // Here we determine if a comment should provoke an action
    switch (comment) {
        case "/apply":
            await gh.addComment(owner, repo, issue, `Processing ${comment}`, ghtoken)
            await runGithubCheckWithHelmfile("apply", e, p)
            await gh.addComment(owner, repo, issue, `Finished processing ${comment}`, ghtoken)
            break
        default:
            if (comment.startsWith("/")) {
                await gh.addComment('mumoshu', repo, issue, `Unsupported command ${comment}`, ghtoken)
            }
            console.log(`No applicable action found for comment: ${comment}`);
    }
}

events.on("issue_comment:created", handleIssueComment);

events.on("push", (e, p) => {
    console.log("handling push....")
    console.log("payload", e.payload)
    var gh = JSON.parse(e.payload)
    if (e.type != "pull_request") {
        helmfile("apply").run()
    }
});

const checkRunImage = "brigadecore/brigade-github-check-run:latest"

events.on("check_suite:requested", checkRequested)
events.on("check_suite:rerequested", checkRequested)
events.on("check_run:rerequested", checkRequested)
events.on("check_run:completed", logEvent)
events.on("check_suite:completed", logEvent)

async function logEvent(e, p) {
    console.log('event', e)
    console.log('payload'. JSON.parse(p))
}

async function checkRequested(e, p) {
    return runGithubCheckWithHelmfile("diff", e, p)
}

// runGithubCheckWithHelmfile runs `helmfile ${cmd}` within a GitHub Check, so that its status(success, failure) and logs
// are visible in the pull request UI.
async function runGithubCheckWithHelmfile(cmd, e, p) {
    const imageForcePull = false

    console.log("check requested")
    // Common configuration
    const env = {
        CHECK_PAYLOAD: e.payload,
        CHECK_NAME: `helmfile-${cmd}`,
        CHECK_TITLE: "Detected Changes",
    }

    // This will represent our build job. For us, it's just an empty thinger.
    const build = helmfile(cmd)
    build.streamLogs = true

    // For convenience, we'll create three jobs: one for each GitHub Check
    // stage.
    const start = new Job("start-run", checkRunImage)
    start.imageForcePull = imageForcePull
    start.env = env
    start.env.CHECK_SUMMARY = "Beginning test run"

    const end = new Job("end-run", checkRunImage)
    end.imageForcePull = imageForcePull
    end.env = env

    try {
        // Now we run the jobs in order:
        // - Notify GitHub of start
        // - Run the test
        // - Notify GitHub of completion
        //
        // On error, we catch the error and notify GitHub of a failure.
        await start.run()
        // In case you see errors like the below in a helmfile pod:
        //   Error: secrets is forbidden: User "system:serviceaccount:default:brigade-worker" cannot list resource "secrets" in API group "" in the namespace "kube-system"
        // It is likely you don't have correct premissions provided to the job pod that runs helmfile.
        // Run something like the below, for testing purpose:
        //   kubectl create clusterrolebinding brigade-worker-as-cluster-admin --serviceaccount default:brigade-worker --clusterrole cluster-admin
        // Hopefully you'll use something stricter in a prod env :)
        await build.run()

        end.env.CHECK_CONCLUSION = "success"
        end.env.CHECK_SUMMARY = "Build completed"
        end.env.CHECK_TEXT = result.toString()
    } catch (err) {
        let logs = "N/A"
        try {
            logs = await build.logs()
        } catch (err2) {
            console.log("failed while gathering logs", {cmd: cmd}, err2)
        }

        // In this case, we mark the ending failed.
        end.env.CHECK_CONCLUSION = "failure"
        end.env.CHECK_SUMMARY = "Build failed"
        end.env.CHECK_TEXT = `Error: ${err}

Logs:
${logs}`
    }
    return await end.run()
}

function helmfile(cmd) {
    var job = new Job(cmd, image)
    job.tasks = [
        "mkdir -p " + dest,
        "cp -a /src/* " + dest,
        "cd " + dest,
        `variant ${cmd}`,
    ]
    return job
}
