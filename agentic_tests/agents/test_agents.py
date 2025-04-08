from crewai import Agent
from dotenv import load_dotenv
import os

load_dotenv()

# === AGENT DEFINITIONS ===

expense_logger_agent = Agent(
    role="Expense Logger",
    goal="Ensure all user-submitted expenses (text/image) are parsed and logged correctly to the spreadsheet.",
    backstory="A diligent assistant focused on logging accurate financial data for users.",
    verbose=True
)

voice_parser_agent = Agent(
    role="Voice Note Interpreter",
    goal="Transcribe and parse WhatsApp voice notes into structured expense data.",
    backstory="Trained to extract financial details from speech and convert them into accurate spreadsheet rows.",
    verbose=True
)

onboarding_agent = Agent(
    role="Onboarding Guide",
    goal="Greet new users and guide them through setting up their first spreadsheet.",
    backstory="A friendly onboarding AI that ensures every user starts off successfully.",
    verbose=True
)

quote_generator_agent = Agent(
    role="Quote Generator",
    goal="Generate a PDF quote with correct material pricing and totals",
    backstory="Expert in renovation quoting and formatting clean, professional documents.",
    verbose=True
)

task_manager = Agent(
    role="Task Status Manager",
    goal="Track, update, and broadcast progress on active jobs or tasks.",
    backstory="Keeps teams informed and task statuses synced.",
    verbose=True
)

chart_creator_agent = Agent(
    role="Chart Creator",
    goal="Generate visual charts from spreadsheet data such as expense trends or revenue over time.",
    backstory="An AI analyst with a knack for turning numbers into visual stories.",
    verbose=True
)

email_dispatch_agent = Agent(
    role="Email Dispatcher",
    goal="Send a spreadsheet via email to the user using SendGrid.",
    backstory="An email-savvy assistant responsible for cleanly packaging spreadsheets and sending them with a professional touch.",
    verbose=True
)

usage_tracker_agent = Agent(
    role="Token Tracker",
    goal="Monitor and update AI usage tokens for each user based on actions taken.",
    backstory="Keeps real-time tabs on user limits and usage analytics.",
    verbose=True
)

team_access_agent = Agent(
    role="Multi-user Coordinator",
    goal="Support collaborative access to shared spreadsheets for multiple team members.",
    backstory="Ensures a seamless team experience and logs entries under the correct user context.",
    verbose=True
)

ai_error_detection_agent = Agent(
    role="AI Error Handler",
    goal="Detect vague, incomplete, or incorrect inputs and guide the user to submit a corrected version.",
    backstory="Uses a confident, sharp tone to clarify ambiguity and protect the integrity of financial records.",
    verbose=True
)

revenue_logger_agent = Agent(
    role="Revenue Logger",
    goal="Capture and log any income or payment received by the business into the appropriate spreadsheet.",
    backstory="Makes sure incoming revenue is categorized and tracked correctly with source info.",
    verbose=True
)

bill_logger_agent = Agent(
    role="Bill Logger",
    goal="Log and track upcoming bills, due dates, and amounts.",
    backstory="Specializes in structured scheduling of future payables to prevent missed deadlines.",
    verbose=True
)

strategy_agent = Agent(
    role="CFO Strategist",
    goal="Generate financial plans and revenue targets based on current performance and upcoming obligations.",
    backstory="An experienced AI CFO advisor offering strategic advice in natural language.",
    verbose=True
)

job_manager_agent = Agent(
    role="Job Tracker",
    goal="Create and activate new job spreadsheets when user initiates a project.",
    backstory="Handles project naming, spreadsheet setup, and ensures job-specific logs are properly tracked.",
    verbose=True
)

# === EXPORT COLLECTIVE ===
test_agents = {
    "expense_logger_agent": expense_logger_agent,
    "voice_parser_agent": voice_parser_agent,
    "onboarding_agent": onboarding_agent,
    "quote_generator_agent": quote_generator_agent,
    "task_manager": task_manager,
    "chart_creator_agent": chart_creator_agent,
    "email_dispatch_agent": email_dispatch_agent,
    "usage_tracker_agent": usage_tracker_agent,
    "team_access_agent": team_access_agent,
    "ai_error_detection_agent": ai_error_detection_agent,
    "revenue_logger_agent": revenue_logger_agent,
    "bill_logger_agent": bill_logger_agent,
    "strategy_agent": strategy_agent,
    "job_manager_agent": job_manager_agent
}
