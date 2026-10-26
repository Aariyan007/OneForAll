"""Weekly completion report for Taskly (evaluation fixture)."""


def completion_rate(tasks):
    """Share of tasks that are done, from 0.0 to 1.0. An empty list counts as 0.0."""
    if not tasks:
        return 0.0
    done = sum(1 for task in tasks if task["done"])
    return done / len(tasks)


def summarize(tasks):
    rate = completion_rate(tasks)
    return f"{len(tasks)} tasks, {rate:.0%} done"
